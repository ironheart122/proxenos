# Proxenos — handover & daily-use assessment (2026-07-18)

> Snapshot of where the project stands, what was verified in a full code read +
> field use, and what to fix before leaning on it daily. Written after a
> line-by-line review of all of `src/` (~1,100 lines), the delegation log, and
> the live deployment.

## What this is

An MCP server that lets Claude Code delegate self-contained coding tasks to
Codex CLI workers (GPT models, ChatGPT-subscription or API auth), each running
in an **isolated git worktree** on its own `delegation/<id>` branch. Claude
writes a dispatch spec (task, acceptance criteria, constraints, verification
command); proxenos runs `codex exec` in the worktree, enforces the contract,
and returns a structured result (summary, obstacles, `criteriaMet`, unified
diff or branch, files touched, verification output, token usage + quota pool).

## Current deployment

- Runs as a **systemd user service** (`proxenos.service`): `serve --http` on
  loopback `127.0.0.1:8137/mcp`, registered in Claude Code as the `proxenos`
  MCP server (streamable HTTP).
- **No config file exists** (`~/.config/proxenos/config.json` absent, no
  repo-local `proxenos.config.json`) → running on the built-in default
  profile: `codexBin: "codex"` resolved from the **daemon's** PATH,
  `sandbox: workspace-write`, no model pin (falls through to
  `~/.codex/config.toml` root `model`, the SSoT).
- Delegation history: append-only JSONL at
  `~/.local/share/proxenos/delegations.jsonl` (full spec + result + usage per
  run; doubles as a future eval dataset). 9 runs to date: 6 completed, 3
  failed — all 3 failures were one environment incident (see "Open items").

## Code map (src/, all of it)

| File | Role |
|---|---|
| `index.ts` | CLI: `serve` (stdio), `serve --http [--port]`, `run --spec` (MCP-less test path) |
| `server.ts` | 5 MCP tools: `delegate_task`, `check_delegation`, `get_delegation_result`, `cancel_delegation`, `list_workers`; stdio + stateless streamable-HTTP modes |
| `schemas.ts` | Zod `DispatchSpec` (the `.describe()` strings are caller-facing prompt engineering), result/record types, worker-profile config schema |
| `config.ts` | Config discovery (cwd → XDG), `default` profile required, XDG data dir |
| `delegation/manager.ts` | Orchestration: start → run worker → snapshot diff → enforce `allowedPaths` → run verification → status resolution → cleanup → persist |
| `delegation/worktree.ts` | Worktree create/diff/cleanup; patch mode deletes branch, direct mode commits + keeps it |
| `delegation/store.ts` | JSONL persistence |
| `worker/codex.ts` | `codex exec --json --ephemeral` runner: process-group kill for timeout/cancel, JSONL event streaming for live progress, token/quota/model attribution |
| `worker/prompt.ts` | Spec → self-contained prompt + `--output-schema` contract (`summary`/`obstacles`/`criteriaMet`) |
| `util/formatDuration.ts` | Cosmetic |

## Verdict

**Good enough for daily use in its designed niche once the two open items
below are fixed** (~30 min of work). The niche: work-order tasks speccable up
front — implementation from a frozen spec, review-as-delegation, parallel
fan-outs. It is **not** a full replacement for the raw `codex exec` flow
(`codex-first` skill), for one structural reason: **no resume**. Runs are
`--ephemeral`; every follow-up redispatch makes the worker rebuild repo
context from scratch, so iterate-until-green loops stay cheaper on raw
`codex exec resume --last`. Keep both; route by task shape.

### What makes it trustworthy (design decisions to preserve)

The recurring pattern is *never trust the worker's self-report*:

1. The diff is **computed by the orchestrator** from the worktree
   (`worktree.ts` `diffWorktree`), never taken from worker claims.
2. `allowedPaths` is enforced **post-hoc from that diff**
   (`manager.ts`, picomatch check) — violations fail the delegation.
3. Verification re-runs **orchestrator-side**; the exit code is the only
   truth (`manager.ts` `runVerification`).
4. The diff snapshot is taken **before** verification runs (`manager.ts`,
   comment above `diffWorktree` call) — the verify command executes
   worker-modified code and may itself write files (lockfiles, snapshots);
   those must not enter the patch or dodge the path check.
5. `codex` is spawned **detached** so timeout/cancel SIGKILLs the whole
   process group — orphaned shells can't keep writing during cleanup
   (`worker/codex.ts`).

Field validation (2026-07-07, PR review delegation against the hyper-space
monorepo, run alongside an 8-angle Claude review as control): the delegation
contributed the top three confirmed findings, unique — none of the eight
Claude finder angles caught them. Same run also confirmed why point 3 above
matters: one worker finding self-rated `"confidence": "high"` was flat wrong.
Full writeup in `docs/field-tests/` (local-only — `docs/` is gitignored).

## Open items — fix before daily driving

### P1: pin `codexBin` (the PATH trap is still armed)

The 2026-07-07 incident: all delegations died in <2s because the systemd
daemon's minimal PATH resolved a **stale nvm-global codex** (0.112.0) ahead of
bun's current one; the old CLI can't run current models. It was patched by
upgrading the nvm copy *in place*, which will silently go stale again after
the next bun-side codex upgrade. Durable fix, still not applied:

- Create `~/.config/proxenos/config.json` with the `default` worker's
  `codexBin` set to an **absolute path**, and restart `proxenos.service`.
- While there, consider `extraArgs: ["-c", "model_reasoning_effort=\"high\""]`
  if `~/.codex/config.toml` doesn't already set it (house default elsewhere).

### P2: plumb `turn.failed` payloads into failure summaries

`worker/codex.ts` streams the JSONL events for progress counting but discards
`error` / `turn.failed` payloads; failures report only the stderr tail, which
is typically empty. In the incident above, the discarded payload contained the
exact one-line diagnosis — its absence turned a 30-second read into a
multi-step bisection. Fix (as specced in the field-test doc): keep a
`lastErrorMessage` while streaming (`event.type === "error" || "turn.failed"`
→ capture `event.message ?? event.error?.message`) and prepend it to the
`settle("failed", …)` error ahead of the stderr tail.

## Known gaps — acceptable, decide later

- **In-memory registry** (HTTP mode): daemon restart mid-delegation loses the
  record and orphans `.proxenos/worktrees/<id>` + its branch; records persist
  to JSONL only at completion. No startup sweep exists. Low frequency; a
  `git worktree prune` + stale-branch sweep on boot would close it.
- **No tests.** ~1,100 lines, stable surface; fine for now, but `manager.ts`
  status-resolution and the path-enforcement logic are cheap to unit-test.
- **Patch application is the caller's job** (`git apply` semantics, conflicts
  on dirty trees). Direct mode (`writeMode: "direct"`) sidesteps this by
  leaving the branch to merge.
- **Default timeout 10 min** (`timeoutMs` 600 000); long builds need an
  explicit raise in the spec.

## Routing rule of thumb (vs `codex-first` skill)

| Task shape | Use |
|---|---|
| Frozen spec, parallel fan-out, review-as-delegation, anything wanting isolation/enforcement | **proxenos** |
| Iterate-until-green, follow-up-heavy, conversational fixes | raw `codex exec` + `resume` (codex-first skill) |
| Design, spec-writing, review of worker output | Claude, never delegated |
