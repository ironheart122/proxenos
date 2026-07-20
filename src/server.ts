import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { DispatchSpec } from "./schemas.js";
import {
  startDelegation,
  getDelegation,
  listDelegations,
  cancelDelegation,
} from "./delegation/manager.js";
import { loadConfig } from "./config.js";
import { resolveModelLabel } from "./worker/codex.js";

function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function rejectUntrustedHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  allowedHosts: ReadonlySet<string>,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const host = req.headers.host;
  const origin = req.headers.origin;

  if (!host || !allowedHosts.has(host) || (origin !== undefined && !allowedOrigins.has(origin))) {
    res.writeHead(403, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Forbidden host or origin" },
        id: null,
      }),
    );
    return true;
  }
  return false;
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "proxenos", version: "0.1.1" });

  server.registerTool(
    "delegate_task",
    {
      title: "Delegate a task to a foreign-model worker",
      description:
        "Dispatch a self-contained coding task to a worker model (e.g. GPT) running in an " +
        "isolated git worktree. Returns immediately with a delegationId — poll with " +
        "check_delegation, then fetch the result with get_delegation_result. The worker has " +
        "NO access to this conversation: the spec must contain everything it needs. " +
        "Delegations can run in parallel.",
      inputSchema: DispatchSpec.shape,
    },
    async (args) => {
      const spec = DispatchSpec.parse(args);
      const rec = await startDelegation(spec);
      return json({
        delegationId: rec.id,
        branch: rec.branch,
        worker: spec.worker,
        hint: `Poll with check_delegation({ delegationId: "${rec.id}" }). Typical tasks take 1-5 minutes.`,
      });
    },
  );

  server.registerTool(
    "check_delegation",
    {
      title: "Check delegation status",
      description:
        "Poll a running delegation. Omit delegationId to list all delegations in this session.",
      inputSchema: { delegationId: z.string().optional() },
    },
    async ({ delegationId }) => {
      if (!delegationId) {
        return json(
          listDelegations().map((r) => ({
            delegationId: r.id,
            status: r.status,
            events: r.events,
            lastAction: r.lastAction,
          })),
        );
      }
      const rec = getDelegation(delegationId);
      if (!rec) return json({ error: `No delegation with id ${delegationId}` });
      return json({
        delegationId: rec.id,
        status: rec.status,
        events: rec.events,
        lastAction: rec.lastAction,
        elapsedMs:
          (rec.finishedAt ? Date.parse(rec.finishedAt) : Date.now()) - Date.parse(rec.startedAt),
      });
    },
  );

  server.registerTool(
    "get_delegation_result",
    {
      title: "Get delegation result",
      description:
        "Fetch the full result contract of a finished delegation: summary, files touched, " +
        "unified diff (patch mode) or branch name (direct mode), verification output, declared " +
        "obstacles, and token/cost usage. Review the patch and obstacles before accepting; " +
        "redispatch with clarifications if acceptance criteria are not met.",
      inputSchema: { delegationId: z.string() },
    },
    async ({ delegationId }) => {
      const rec = getDelegation(delegationId);
      if (!rec) return json({ error: `No delegation with id ${delegationId}` });
      if (rec.status === "running") {
        return json({
          error: "Delegation still running — poll check_delegation until it completes.",
          events: rec.events,
          lastAction: rec.lastAction,
        });
      }
      return json(rec.result ?? { status: rec.status, error: rec.error });
    },
  );

  server.registerTool(
    "cancel_delegation",
    {
      title: "Cancel a running delegation",
      description:
        "Request cancellation of a running delegation. Stops the worker or verification command.",
      inputSchema: { delegationId: z.string() },
    },
    async ({ delegationId }) => json({ cancelled: cancelDelegation(delegationId) }),
  );

  server.registerTool(
    "list_workers",
    {
      title: "List configured worker profiles",
      description: "Show the named worker profiles (model + sandbox) available for delegate_task.",
      inputSchema: {},
    },
    async () => {
      const cfg = loadConfig();
      return json(
        Object.fromEntries(
          Object.entries(cfg.workers).map(([name, w]) => [
            name,
            { model: resolveModelLabel(w), sandbox: w.sandbox },
          ]),
        ),
      );
    },
  );

  return server;
}

export async function serve(): Promise<void> {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  console.error("proxenos MCP server running on stdio");
}

/**
 * Long-running HTTP mode for a persistent (e.g. systemd) deployment. Stateless
 * streamable-HTTP: each POST gets a fresh McpServer/transport pair, but the
 * delegation registry is module-level state in manager.ts, so every client
 * session sees the same delegations. Binds to loopback only — there is no auth.
 */
export async function serveHttp(port: number): Promise<void> {
  const allowedHosts = ["127.0.0.1", `127.0.0.1:${port}`, "localhost", `localhost:${port}`];
  const allowedOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const allowedHostSet = new Set(allowedHosts);
  const allowedOriginSet = new Set(allowedOrigins);
  const httpServer = createServer(async (req, res) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed — stateless server, POST only",
          },
          id: null,
        }),
      );
      return;
    }
    // Validate before buffering or parsing an attacker-controlled request body.
    // Keep this application-level guard even though the SDK transport repeats
    // the check, so dependency resolution cannot silently remove the boundary.
    if (rejectUntrustedHttpRequest(req, res, allowedHostSet, allowedOriginSet)) return;

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error" },
          id: null,
        }),
      );
      return;
    }

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      httpServer.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      console.error(`proxenos MCP server listening on http://127.0.0.1:${port}/mcp`);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, "127.0.0.1");
  });
}
