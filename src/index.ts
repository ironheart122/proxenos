#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { serve, serveHttp } from "./server.js";
import { DispatchSpec } from "./schemas.js";
import { startDelegation, getDelegation } from "./delegation/manager.js";

const USAGE = `proxenos - delegate coding tasks to foreign-model workers via MCP

Usage:
  proxenos serve                 Start the MCP server (stdio). Register with:
                                 claude mcp add proxenos -- npx -y proxenos serve
  proxenos serve --http [--port <n>]
                                 Start a persistent MCP server on streamable
                                 HTTP (loopback only, default port 8137).
                                 Register with:
                                 claude mcp add --transport http proxenos http://127.0.0.1:8137/mcp
  proxenos run --spec <file>     Run one delegation from a JSON spec file and
                                 print the result (for testing without MCP).
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "serve": {
      if (rest.includes("--http")) {
        const portIdx = rest.indexOf("--port");
        const port = portIdx !== -1 && rest[portIdx + 1] ? Number(rest[portIdx + 1]) : 8137;
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          console.error(`invalid --port value: ${rest[portIdx + 1]}`);
          process.exit(1);
        }
        await serveHttp(port);
      } else {
        await serve();
      }
      return;
    }

    case "run": {
      const flagIdx = rest.indexOf("--spec");
      const specPath = flagIdx === -1 ? undefined : rest[flagIdx + 1];
      if (!specPath) {
        console.error("run requires --spec <file.json>");
        process.exit(1);
      }
      const spec = DispatchSpec.parse(JSON.parse(readFileSync(specPath, "utf8")));
      const rec = await startDelegation(spec);
      console.error(`delegation ${rec.id} started on ${rec.branch}`);

      // Poll until terminal, streaming progress to stderr.
      let last = "";
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const cur = getDelegation(rec.id)!;
        const line = `[${cur.status}] events=${cur.events} ${cur.lastAction}`;
        if (line !== last) {
          console.error(line);
          last = line;
        }
        if (cur.status !== "running") {
          console.log(JSON.stringify(cur.result, null, 2));
          process.exit(cur.status === "completed" ? 0 : 1);
        }
      }
    }

    default:
      console.error(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
