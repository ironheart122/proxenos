import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export async function serve(): Promise<void> {
  const server = new McpServer({ name: "proxenos", version: "0.1.0" });

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
    }
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
          }))
        );
      }
      const rec = getDelegation(delegationId);
      if (!rec) return json({ error: `No delegation with id ${delegationId}` });
      return json({
        delegationId: rec.id,
        status: rec.status,
        events: rec.events,
        lastAction: rec.lastAction,
        elapsedMs: (rec.finishedAt ? Date.parse(rec.finishedAt) : Date.now()) - Date.parse(rec.startedAt),
      });
    }
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
    }
  );

  server.registerTool(
    "cancel_delegation",
    {
      title: "Cancel a running delegation",
      description: "Request cancellation of a running delegation. Kills the codex process.",
      inputSchema: { delegationId: z.string() },
    },
    async ({ delegationId }) => json({ cancelled: cancelDelegation(delegationId) })
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
          Object.entries(cfg.workers).map(([name, w]) => [name, { model: resolveModelLabel(w), sandbox: w.sandbox }])
        )
      );
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("proxenos MCP server running on stdio");
}
