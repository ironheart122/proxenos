import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupWorktree,
  createWorktree,
  diffWorktree,
  filesTouched,
} from "../dist/delegation/worktree.js";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "proxenos-worktree-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Proxenos Test");
  git(repo, "config", "user.email", "proxenos@example.invalid");
  writeFileSync(join(repo, "allowed.txt"), "base\n");
  git(repo, "add", "allowed.txt");
  git(repo, "commit", "--quiet", "-m", "base");
  return { root, repo };
}

test("captures changes committed by a worker against the original base", async () => {
  const { root, repo } = createRepo();
  const wt = await createWorktree(repo, "committed-change");

  try {
    writeFileSync(join(wt.path, "outside.txt"), "worker output\n");
    git(wt.path, "add", "outside.txt");
    git(wt.path, "commit", "--quiet", "-m", "worker commit");

    assert.notEqual(git(wt.path, "rev-parse", "HEAD"), wt.baseCommit);
    assert.match(await diffWorktree(wt), /outside\.txt/);
    assert.deepEqual(await filesTouched(wt), [{ path: "outside.txt", action: "created" }]);
  } finally {
    await cleanupWorktree(repo, wt, { keepBranch: false });
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports both sides of a rename for path enforcement", async () => {
  const { root, repo } = createRepo();
  const wt = await createWorktree(repo, "rename");

  try {
    git(wt.path, "mv", "allowed.txt", "outside.txt");
    assert.deepEqual(await filesTouched(wt), [
      { path: "allowed.txt", action: "deleted" },
      { path: "outside.txt", action: "created" },
    ]);
  } finally {
    await cleanupWorktree(repo, wt, { keepBranch: false });
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves staged output when a direct-mode commit fails", async () => {
  const { root, repo } = createRepo();
  const wt = await createWorktree(repo, "failed-commit");

  try {
    writeFileSync(join(wt.path, "output.txt"), "worker output\n");
    await filesTouched(wt);
    git(repo, "config", "user.name", "");

    await assert.rejects(cleanupWorktree(repo, wt, { keepBranch: true }));
    assert.equal(existsSync(wt.path), true);
    assert.match(git(wt.path, "status", "--short"), /output\.txt/);
  } finally {
    git(repo, "config", "user.name", "Proxenos Test");
    if (existsSync(wt.path)) {
      await cleanupWorktree(repo, wt, { keepBranch: false });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
