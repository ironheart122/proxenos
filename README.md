# proxenos

> *próxenos (πρόξενος): a citizen appointed to represent a foreign state's interests in his own city.*

An MCP server that lets Claude Code delegate coding tasks to **Codex CLI workers**, each running inside an **isolated git worktree**. Codex supplies the agent loop and sandbox; proxenos supplies the dispatch contract, isolation, verification, and observability.

Claude plans and verifies. Codex executes — on your **ChatGPT subscription quota** (via `codex login`) or an API key. No separate API billing required.

## Why

- **Subscription arbitrage** — route bulk mechanical work (test generation, codemods, boilerplate) to Codex on quota you already pay for, while Claude keeps the high-context reasoning.
- **Isolation by construction** — every delegation runs in its own `git worktree` on a fresh branch. A runaway worker physically cannot touch your checked-out branch.
- **A real contract, not stdout scraping** — structured dispatch specs in, structured results out: summary, unified diff, files touched, verification output, declared obstacles, and per-delegation token/cost usage.
- **Async & parallel** — `delegate_task` returns a ticket immediately. Dispatch three delegations, poll them together.

## Install

```bash
claude mcp add proxenos -- npx -y proxenos serve
```

Requires the [Codex CLI](https://developers.openai.com/codex) installed and authenticated (`codex login` — ChatGPT sign-in uses your subscription quota; an API key uses platform billing).

Worker profiles are `codex exec` presets, in `proxenos.config.json` (project root) or `~/.config/proxenos/config.json`:

```json
{
  "workers": {
    "default": { "sandbox": "workspace-write" },
    "spark":   { "model": "gpt-5.3-codex-spark", "sandbox": "workspace-write" }
  }
}
```

## The MCP surface

| Tool | Purpose |
| --- | --- |
| `delegate_task` | Validate a dispatch spec, spin up a worktree + worker loop, return a `delegationId` immediately |
| `check_delegation` | Poll status: iteration count, last tool action, elapsed time |
| `get_delegation_result` | Full result contract once terminal |
| `cancel_delegation` | Stop a runaway worker at the next iteration boundary |
| `list_workers` | Show configured worker profiles |

## The dispatch spec

The worker has **no conversation context** — the spec is a self-contained ticket:

```jsonc
{
  "task": "…imperative, complete, names concrete files and functions…",
  "context": { "workingDir": "/repo", "seedFiles": ["src/…"], "conventions": "…" },
  "acceptanceCriteria": ["checkable", "conditions"],
  "constraints": {
    "writeMode": "patch",            // or "direct" (leaves a delegation/<id> branch to merge)
    "allowedPaths": ["src/pricing/**"],  // enforced post-hoc from the diff
    "timeoutMs": 600000
  },
  "verification": { "command": "pnpm test --filter pricing" },
  "worker": "default"     // codex exec preset from config
}
```

## The result contract

```jsonc
{
  "status": "completed",             // failed | budget_exceeded | timeout | cancelled
  "summary": "…worker's account…",
  "filesTouched": [{ "path": "src/…", "action": "modified" }],
  "patch": "diff --git …",           // patch mode: review then `git apply`
  "branch": null,                     // direct mode: "delegation/<id>" to merge
  "verification": { "command": "…", "exitCode": 0, "outputTail": "…" },
  "obstacles": ["couldn't find X, assumed Y"],
  "criteriaMet": true,
  "usage": { "inputTokens": 41200, "outputTokens": 6300,
             "quota": "chatgpt-subscription", "events": 38,
             "wallTimeMs": 92000, "model": "codex-default" }
}
```

`obstacles` and `criteriaMet` come from Codex itself: the final message is forced
through `--output-schema` into `{summary, obstacles, criteriaMet}`, so the
structured contract survives even though Codex owns the agent loop.

## The dispatcher subagent

`examples/agents/delegate.md` is a Claude Code custom subagent that encodes the whole pattern — spec-writing discipline, polling, obstacle review, accept/redispatch/escalate verdicts. Drop it in `.claude/agents/` and:

```
> Use the delegate subagent to generate tests for the pricing module
```

## Testing without MCP

```bash
proxenos run --spec examples/spec.example.json
```

Runs one delegation end-to-end and prints the result contract — useful for iterating on spec formats and worker prompts.

## Observability

Every delegation (full spec + result + usage) is appended to
`~/.local/share/proxenos/delegations.jsonl`. That's your cost log today and an
eval dataset later: replay old specs against new worker models and diff outcomes.

## Safety model

- Each delegation runs in its own worktree on a fresh branch — a runaway worker cannot touch your checked-out branch.
- Codex runs under its own sandbox (`workspace-write` by default), scoped to the worktree via `-C`.
- `allowedPaths` globs are enforced post-hoc from the diff: out-of-bounds writes fail the delegation.
- Verification runs orchestrator-side — the worker claiming tests pass is not trusted; the exit code is.
- Wall-clock timeout kills the codex process group; patch mode keeps a review gate before anything touches your tree.
- **Known trust boundary**: the verification command runs *unsandboxed*, against worker-modified code. The worker can't choose the command, but it controls what the command executes (`package.json` scripts, test files). A malicious worker could plant code that verification runs with your full privileges. Keep verification commands minimal, and treat their execution as executing worker output.

## Quota note

With ChatGPT sign-in, delegations draw from the same rolling usage window as
your interactive Codex sessions — parallel-dispatching six delegations has a
real cost even at $0. The `usage.quota` field (`chatgpt-subscription` | `api` |
`unknown`, detected from codex's cached auth) exists so orchestrators can
reason about this.

Also note: each worktree is a fresh checkout — no `node_modules`. A worker that
needs dependencies pays the install in wall time *and* tokens; keep verification
commands dependency-light where you can.

## License

MIT
