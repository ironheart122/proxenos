import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import test from "node:test";

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "proxenos-test", version: "1" },
  },
});

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return address.port;
}

function post(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(initialize),
        ...headers,
      },
    }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.end(initialize);
  });
}

test("persistent HTTP mode rejects non-loopback hosts and origins", async () => {
  const port = await availablePort();
  const child = spawn(process.execPath, ["dist/index.js", "serve", "--http", "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("HTTP server did not start")), 5_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`HTTP server exited before startup (${code})`));
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (chunk.includes("listening on")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    assert.equal(await post(port), 200);
    assert.equal(await post(port, { origin: "http://evil.example" }), 403);
    assert.equal(await post(port, { host: "evil.example" }), 403);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
});
