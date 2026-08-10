import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import picomatch from "picomatch";
import { loadConfig, resolveWorker } from "../config.js";
import { runCodexWorker } from "../worker/codex.js";
import { createWorktree, diffWorktree, filesTouched, cleanupWorktree } from "./worktree.js";
import { warmDependencies } from "./warmDeps.js";
import { persistRecord } from "./store.js";
import { nonInteractiveEnv } from "../util/nonInteractiveEnv.js";
import type {
  DispatchSpec,
  DelegationRecord,
  DelegationResult,
  DelegationStatus,
} from "../schemas.js";

const registry = new Map<string, DelegationRecord>();
const cancellations = new Set<string>();

export function getDelegation(id: string): DelegationRecord | undefined {
  return registry.get(id);
}

export function listDelegations(): DelegationRecord[] {
  return [...registry.values()];
}

export function cancelDelegation(id: string): boolean {
  const rec = registry.get(id);
  if (!rec || rec.status !== "running") return false;
  cancellations.add(id);
  return true;
}

/** Start a delegation. Returns immediately; codex runs in the background. */
export async function startDelegation(spec: DispatchSpec): Promise<DelegationRecord> {
  const config = loadConfig();
  const profile = resolveWorker(config, spec.worker); // fail fast on bad profile

  const id = randomBytes(4).toString("hex");
  const wt = await createWorktree(spec.context.workingDir, id);

  const record: DelegationRecord = {
    id,
    spec,
    status: "running",
    worktreePath: wt.path,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    events: 0,
    lastAction: "starting codex",
    result: null,
    error: null,
  };
  registry.set(id, record);

  void runDelegation(record, profile).catch(async (err) => {
    record.status = "failed";
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = new Date().toISOString();
    cancellations.delete(id);
    // runDelegation died before its own cleanup — don't leak the worktree,
    // and keep the failure in the JSONL log so the eval dataset sees it.
    await cleanupWorktree(spec.context.workingDir, wt, {
      keepBranch: false,
    }).catch(() => {});
    persistRecord(record);
  });

  return record;
}

async function runDelegation(
  record: DelegationRecord,
  profile: ReturnType<typeof resolveWorker>,
): Promise<void> {
  const { spec, id } = record;
  const wt = {
    path: record.worktreePath,
    branch: record.branch,
    baseCommit: record.baseCommit,
  };

  // Warm the worktree before the worker sees it: a cold worktree makes the
  // worker (and later, verification) pay a full dependency install inside the
  // sandbox, where the operator's package-manager store isn't writable (#12).
  record.lastAction = "pre-installing dependencies";
  const depWarning = await warmDependencies(wt.path);

  const outcome = await runCodexWorker(spec, profile, wt.path, {
    onEvent: (events, lastAction) => {
      record.events = events;
      record.lastAction = lastAction;
    },
    isCancelled: () => cancellations.has(id),
  });

  // Snapshot the worker's output BEFORE verification runs: the verification
  // command executes worker-modified code and may itself write files (lockfile
  // refreshes, snapshots) — those must not enter the patch or dodge the
  // allowedPaths check below.
  const patch = await diffWorktree(wt);
  const touched = await filesTouched(wt);
  const obstacles = [...(outcome.finish?.obstacles ?? [])];
  if (depWarning) obstacles.push(depWarning);

  // Post-hoc allowedPaths enforcement: codex's own sandbox can't express our
  // globs, so violations are detected from the diff and fail the delegation.
  let pathViolation = false;
  if (spec.constraints.allowedPaths?.length) {
    const ok = (p: string) => spec.constraints.allowedPaths!.some((g) => picomatch.isMatch(p, g));
    const violations = touched.filter((f) => !ok(f.path)).map((f) => f.path);
    if (violations.length) {
      pathViolation = true;
      obstacles.push(`VIOLATION: wrote outside allowedPaths: ${violations.join(", ")}`);
    }
  }

  // Orchestrator-side verification: the worker claiming it ran tests is not
  // trusted — this exit code is.
  let verification: DelegationResult["verification"] = null;
  if (
    spec.verification &&
    outcome.terminal === "finished" &&
    !pathViolation &&
    !cancellations.has(id)
  ) {
    record.lastAction = "running verification";
    verification = await runVerification(
      wt.path,
      spec.verification.command,
      spec.verification.timeoutMs,
      () => cancellations.has(id),
    );
  }

  const cancelled =
    outcome.terminal === "cancelled" || (outcome.terminal === "finished" && cancellations.has(id));
  let status: DelegationStatus =
    outcome.terminal === "finished"
      ? cancelled
        ? "cancelled"
        : pathViolation || (verification !== null && verification.exitCode !== 0)
          ? "failed"
          : "completed"
      : outcome.terminal === "timeout"
        ? "timeout"
        : outcome.terminal === "cancelled"
          ? "cancelled"
          : "failed";

  const keepBranch = spec.constraints.writeMode === "direct" && status === "completed";
  let cleanupError: string | null = null;
  try {
    await cleanupWorktree(spec.context.workingDir, wt, { keepBranch });
  } catch (err) {
    cleanupError = err instanceof Error ? err.message : String(err);
    obstacles.push(`Could not finalize delegation worktree: ${cleanupError}`);
    // A direct-mode result is unusable until its branch commit succeeds.
    if (keepBranch) status = "failed";
  }

  const result: DelegationResult = {
    status,
    summary: outcome.finish?.summary ?? outcome.error ?? `terminal state: ${outcome.terminal}`,
    filesTouched: touched,
    patch: spec.constraints.writeMode === "patch" && patch.trim() ? patch : null,
    branch: keepBranch && cleanupError === null ? wt.branch : null,
    verification,
    obstacles,
    criteriaMet: outcome.finish?.criteriaMet ?? null,
    usage: outcome.usage,
  };

  record.status = status;
  record.result = result;
  record.error = cleanupError ?? outcome.error ?? null;
  record.finishedAt = new Date().toISOString();
  cancellations.delete(id);
  persistRecord(record);
}

export function runVerification(
  cwd: string,
  command: string,
  timeoutMs: number,
  isCancelled: () => boolean,
): Promise<NonNullable<DelegationResult["verification"]>> {
  return new Promise((resolve) => {
    if (isCancelled()) {
      resolve({ command, exitCode: 1, outputTail: "verification cancelled" });
      return;
    }

    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: nonInteractiveEnv(),
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let terminal: "timeout" | "cancelled" | null = null;
    let settled = false;

    const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(-8_192);
    const killHard = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const settle = (exitCode: number, suffix = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      const output = [stdout, stderr, suffix].filter(Boolean).join("\n");
      resolve({
        command,
        exitCode,
        outputTail: output.length > 4_000 ? output.slice(-4_000) : output,
      });
    };
    const timer = setTimeout(() => {
      terminate("timeout");
    }, timeoutMs);
    const cancelPoll = setInterval(() => {
      if (isCancelled()) {
        terminate("cancelled");
      }
    }, 250);
    const terminate = (reason: NonNullable<typeof terminal>) => {
      if (terminal !== null) return;
      terminal = reason;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      killHard();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (err) => settle(1, `failed to start verification: ${err.message}`));
    child.on("close", (code) => {
      if (terminal === "cancelled") return settle(1, "verification cancelled");
      if (terminal === "timeout") return settle(1, "verification timed out");
      settle(code ?? 1);
    });
  });
}
