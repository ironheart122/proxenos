import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectInstall, warmDependencies } from "../dist/delegation/warmDeps.js";
import { cleanupWorktree, createWorktree, filesTouched } from "../dist/delegation/worktree.js";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "proxenos-warm-deps-test-"));
}

test("detectInstall: no package.json means no install", () => {
  const dir = tmp();
  try {
    assert.equal(detectInstall(dir), null);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    assert.equal(detectInstall(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectInstall: package.json without a lockfile means no install", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    assert.equal(detectInstall(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectInstall: pnpm wins over npm when both lockfiles exist", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "package-lock.json"), "{}");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    assert.equal(detectInstall(dir)?.bin, "pnpm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectInstall: pnpm forces standalone mode unless the repo is a workspace", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    assert.ok(detectInstall(dir).args.includes("--ignore-workspace"));
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
    assert.ok(!detectInstall(dir).args.includes("--ignore-workspace"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Full path: a committed repo with a file: dependency and a real pnpm lockfile.
// The worktree install must produce node_modules without touching the diff.
function createNodeRepo({ gitignore }) {
  const root = tmp();
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Proxenos Test");
  git(repo, "config", "user.email", "proxenos@example.invalid");
  mkdirSync(join(repo, "vendor", "dep"), { recursive: true });
  writeFileSync(
    join(repo, "vendor", "dep", "package.json"),
    JSON.stringify({ name: "dep", version: "1.0.0" }),
  );
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "warm-deps-fixture",
      version: "1.0.0",
      dependencies: { dep: "file:vendor/dep" },
    }),
  );
  if (gitignore) writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  // Generate a real lockfile, then drop the install so the worktree starts cold.
  execFileSync("pnpm", ["install", "--ignore-workspace"], { cwd: repo, stdio: "pipe" });
  rmSync(join(repo, "node_modules"), { recursive: true, force: true });
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "base");
  return { root, repo };
}

test("warmDependencies installs into the worktree without polluting the diff", async () => {
  const { root, repo } = createNodeRepo({ gitignore: true });
  const wt = await createWorktree(repo, "warm");
  try {
    assert.equal(existsSync(join(wt.path, "node_modules")), false);
    const warning = await warmDependencies(wt.path);
    assert.equal(warning, null);
    assert.ok(existsSync(join(wt.path, "node_modules", "dep", "package.json")));
    assert.deepEqual(await filesTouched(wt), []);
  } finally {
    await cleanupWorktree(repo, wt, { keepBranch: false });
    rmSync(root, { recursive: true, force: true });
  }
});

test("warmDependencies skips when node_modules is not gitignored", async () => {
  const { root, repo } = createNodeRepo({ gitignore: false });
  const wt = await createWorktree(repo, "unignored");
  try {
    const warning = await warmDependencies(wt.path);
    assert.match(warning, /pre-install skipped/);
    assert.equal(existsSync(join(wt.path, "node_modules")), false);
    assert.deepEqual(await filesTouched(wt), []);
  } finally {
    await cleanupWorktree(repo, wt, { keepBranch: false });
    rmSync(root, { recursive: true, force: true });
  }
});

test("warmDependencies reports failure without throwing", async () => {
  const { root, repo } = createNodeRepo({ gitignore: true });
  const wt = await createWorktree(repo, "broken-lockfile");
  try {
    // A lockfile that cannot satisfy --frozen-lockfile.
    writeFileSync(join(wt.path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const warning = await warmDependencies(wt.path);
    assert.match(warning, /pre-install failed/);
  } finally {
    await cleanupWorktree(repo, wt, { keepBranch: false });
    rmSync(root, { recursive: true, force: true });
  }
});
