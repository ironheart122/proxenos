import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { FileTouched } from "../schemas.js";
import { nonInteractiveEnv } from "../util/nonInteractiveEnv.js";

const exec = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    env: nonInteractiveEnv(),
  });
  return stdout;
}

export interface Worktree {
  path: string;
  branch: string;
  baseCommit: string;
}

/**
 * Every delegation gets its own worktree on a fresh branch. The worker's file
 * tools are jailed to this path, so a runaway worker physically cannot touch
 * the caller's checked-out branch.
 */
export async function createWorktree(repoDir: string, id: string): Promise<Worktree> {
  if (!existsSync(repoDir)) {
    throw new Error(
      `context.workingDir '${repoDir}' does not exist — set it to the absolute path of the repo the worker should operate on`,
    );
  }
  await git(repoDir, ["rev-parse", "--is-inside-work-tree"]).catch(() => {
    throw new Error(
      `context.workingDir '${repoDir}' is not inside a git repository — proxenos needs a git repo to create delegation worktrees`,
    );
  });
  const branch = `delegation/${id}`;
  // Keep an immutable comparison point. The worker may create commits, which
  // moves the worktree's HEAD and must not hide those changes from the patch or
  // allowedPaths enforcement.
  const baseCommit = (await git(repoDir, ["rev-parse", "HEAD"])).trim();
  const base = join(repoDir, ".proxenos", "worktrees");
  mkdirSync(base, { recursive: true });
  const path = join(base, id);
  await git(repoDir, ["worktree", "add", "-b", branch, path, baseCommit]);
  return { path, branch, baseCommit };
}

/** Stage everything and emit the full worker diff against its immutable base. */
export async function diffWorktree(wt: Worktree): Promise<string> {
  await git(wt.path, ["add", "-A"]);
  // --binary so patches containing binary files survive `git apply`.
  return git(wt.path, ["diff", "--cached", "--binary", wt.baseCommit]);
}

export async function filesTouched(wt: Worktree): Promise<FileTouched[]> {
  await git(wt.path, ["add", "-A"]);
  // Disabling rename detection reports the source as deleted and destination
  // as created, so allowedPaths evaluates both sides of a move.
  const out = await git(wt.path, [
    "diff",
    "--cached",
    "--no-renames",
    "--name-status",
    wt.baseCommit,
  ]);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      const path = rest[rest.length - 1];
      if (!status || !path) throw new Error(`Unexpected git name-status line: ${line}`);
      const action = status.startsWith("A")
        ? "created"
        : status.startsWith("D")
          ? "deleted"
          : "modified";
      return { path, action } as FileTouched;
    });
}

/**
 * In 'patch' mode we remove worktree AND branch — the diff is the deliverable.
 * In 'direct' mode we remove the worktree but keep the branch for the caller
 * to review/merge (`git merge delegation/<id>`).
 */
export async function cleanupWorktree(
  repoDir: string,
  wt: Worktree,
  opts: { keepBranch: boolean },
): Promise<void> {
  if (opts.keepBranch && (await hasStagedChanges(wt.path))) {
    // Do not remove the worktree unless the branch contains the worker's changes.
    await git(wt.path, ["commit", "-m", `proxenos: delegation ${wt.branch}`, "--no-verify"]);
  }
  await git(repoDir, ["worktree", "remove", "--force", wt.path]);
  if (!opts.keepBranch) {
    await git(repoDir, ["branch", "-D", wt.branch]).catch(() => {});
  }
}

async function hasStagedChanges(repoDir: string): Promise<boolean> {
  try {
    await git(repoDir, ["diff", "--cached", "--quiet", "HEAD"]);
    return false;
  } catch (err) {
    if ((err as { code?: number }).code === 1) return true;
    throw err;
  }
}
