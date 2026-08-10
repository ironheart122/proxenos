import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runVerification } from "../dist/delegation/manager.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

test("preserves a verification command's nonzero exit code", async () => {
  const result = await runVerification(process.cwd(), "exit 42", 5_000, () => false);

  assert.equal(result.exitCode, 42);
});

test("cancellation terminates the verification process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "proxenos-verification-test-"));
  const marker = join(root, "descendant-finished");
  let cancelled = false;
  const cancelTimer = setTimeout(() => {
    cancelled = true;
  }, 50);

  try {
    const result = await runVerification(
      process.cwd(),
      `(sleep 1; touch ${shellQuote(marker)}) & wait`,
      5_000,
      () => cancelled,
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.outputTail, /verification cancelled/);
    await delay(1_100);
    assert.equal(existsSync(marker), false);
  } finally {
    clearTimeout(cancelTimer);
    rmSync(root, { recursive: true, force: true });
  }
});
