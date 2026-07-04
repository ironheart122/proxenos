import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import picomatch from "picomatch";
import { loadConfig, resolveWorker } from "../config.js";
import { runCodexWorker } from "../worker/codex.js";
import { createWorktree, diffWorktree, filesTouched, cleanupWorktree } from "./worktree.js";
import { persistRecord } from "./store.js";
import type { DispatchSpec, DelegationRecord, DelegationResult, DelegationStatus } from "../schemas.js";

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
    await cleanupWorktree(spec.context.workingDir, { path: wt.path, branch: wt.branch }, {
      keepBranch: false,
    }).catch(() => {});
    persistRecord(record);
  });

  return record;
}

async function runDelegation(
  record: DelegationRecord,
  profile: ReturnType<typeof resolveWorker>
): Promise<void> {
  const { spec, id } = record;
  const wt = { path: record.worktreePath, branch: record.branch };

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
  if (spec.verification && outcome.terminal === "finished" && !pathViolation) {
    verification = await runVerification(wt.path, spec.verification.command, spec.verification.timeoutMs);
  }

  const status: DelegationStatus =
    outcome.terminal === "finished"
      ? pathViolation || (verification !== null && verification.exitCode !== 0)
        ? "failed"
        : "completed"
      : outcome.terminal === "timeout"
        ? "timeout"
        : outcome.terminal === "cancelled"
          ? "cancelled"
          : "failed";

  const keepBranch = spec.constraints.writeMode === "direct" && status === "completed";
  await cleanupWorktree(spec.context.workingDir, wt, { keepBranch }).catch(() => {});

  const result: DelegationResult = {
    status,
    summary: outcome.finish?.summary ?? outcome.error ?? `terminal state: ${outcome.terminal}`,
    filesTouched: touched,
    patch: spec.constraints.writeMode === "patch" && patch.trim() ? patch : null,
    branch: keepBranch ? wt.branch : null,
    verification,
    obstacles,
    criteriaMet: outcome.finish?.criteriaMet ?? null,
    usage: outcome.usage,
  };

  record.status = status;
  record.result = result;
  record.error = outcome.error ?? null;
  record.finishedAt = new Date().toISOString();
  cancellations.delete(id);
  persistRecord(record);
}

function runVerification(
  cwd: string,
  command: string,
  timeoutMs: number
): Promise<NonNullable<DelegationResult["verification"]>> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join("\n");
        const rawCode = (err as { code?: number | string } | null)?.code;
        resolve({
          command,
          exitCode: err ? (typeof rawCode === "number" ? rawCode : 1) : 0,
          outputTail: out.length > 4000 ? out.slice(-4000) : out,
        });
      }
    );
  });
}
