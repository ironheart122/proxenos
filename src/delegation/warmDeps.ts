import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nonInteractiveEnv } from "../util/nonInteractiveEnv.js";

const exec = promisify(execFile);

const INSTALL_TIMEOUT_MS = 300_000;

export interface InstallCommand {
  bin: string;
  args: string[];
  lockfile: string;
}

/**
 * Map the worktree's lockfile to a frozen, offline-preferring install command.
 * Frozen matters twice over: the install must reproduce the lockfile at
 * baseCommit, and it must not rewrite the lockfile — verification file writes
 * are kept out of the patch by ordering, but this runs BEFORE the worker, so a
 * mutated lockfile would be attributed to the worker's diff.
 */
export function detectInstall(dir: string): InstallCommand | null {
  if (!existsSync(join(dir, "package.json"))) return null;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) {
    const args = ["install", "--frozen-lockfile", "--prefer-offline"];
    // The worktree lives inside the target repo (.proxenos/worktrees/<id>);
    // without this, pnpm's upward walk can adopt the parent checkout as the
    // workspace root and install into the wrong tree. Repos that are
    // themselves workspaces have pnpm-workspace.yaml in the worktree, which
    // stops the walk — only force standalone mode when they don't.
    if (!existsSync(join(dir, "pnpm-workspace.yaml"))) args.push("--ignore-workspace");
    return { bin: "pnpm", args, lockfile: "pnpm-lock.yaml" };
  }
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) {
    return { bin: "bun", args: ["install", "--frozen-lockfile"], lockfile: "bun.lock" };
  }
  if (existsSync(join(dir, "package-lock.json"))) {
    return {
      bin: "npm",
      args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
      lockfile: "package-lock.json",
    };
  }
  if (existsSync(join(dir, "yarn.lock"))) {
    // Deprecated alias for --immutable on yarn berry; exact flag on classic.
    return { bin: "yarn", args: ["install", "--frozen-lockfile"], lockfile: "yarn.lock" };
  }
  return null;
}

/**
 * The diff is captured with `git add -A`, so anything the pre-install writes
 * must be invisible to git. There is no per-worktree escape hatch here:
 * info/exclude resolves to the COMMON git dir (shared with the operator's
 * checkout — verified empirically; a file at .git/worktrees/<id>/info/exclude
 * is simply not read). So the repo's own ignore rules are the only safe
 * mechanism, and installing into a repo that doesn't ignore node_modules
 * would dump thousands of files into the delegation diff.
 */
async function isGitIgnored(wtPath: string, path: string): Promise<boolean> {
  try {
    await exec("git", ["-C", wtPath, "check-ignore", "-q", path], {
      env: nonInteractiveEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-install dependencies in a fresh worktree so the worker and verification
 * start warm. This runs orchestrator-side — outside the worker sandbox — so
 * the operator's real package-manager store is available; a warm pnpm install
 * is hardlinks and takes seconds. Failure is never fatal: the worker starts
 * cold exactly as it did before this existed, and the returned warning
 * surfaces in the result's obstacles.
 */
export async function warmDependencies(wtPath: string): Promise<string | null> {
  const install = detectInstall(wtPath);
  if (!install) return null;
  // Trailing slash matters: node_modules doesn't exist yet, and the common
  // ignore pattern `node_modules/` is directory-only — check-ignore on the
  // bare name reports "not ignored" for a path git can't see is a directory.
  if (!(await isGitIgnored(wtPath, "node_modules/"))) {
    return (
      "Dependency pre-install skipped: node_modules is not gitignored in this repo, " +
      "so an installed node_modules would pollute the delegation diff. The worker starts cold."
    );
  }
  try {
    await exec(install.bin, install.args, {
      cwd: wtPath,
      env: { ...nonInteractiveEnv(), CI: "1" },
      timeout: INSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const message = err instanceof Error ? err.message : String(err);
    const detail = (stderr.trim() || message).slice(-500);
    return (
      `Dependency pre-install failed (${install.bin} ${install.args.join(" ")}); ` +
      `the worker started without node_modules: ${detail}`
    );
  }
}
