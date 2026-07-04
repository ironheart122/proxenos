import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { DispatchSpec, WorkerProfile, Usage } from "../schemas.js";
import { buildPrompt, OUTPUT_SCHEMA } from "./prompt.js";

export interface FinishPayload {
  summary: string;
  obstacles: string[];
  criteriaMet: boolean;
}

export interface WorkerCallbacks {
  onEvent?: (events: number, lastAction: string) => void;
  isCancelled?: () => boolean;
}

export interface WorkerOutcome {
  finish: FinishPayload | null;
  terminal: "finished" | "timeout" | "cancelled" | "failed";
  error?: string;
  usage: Usage;
}

/**
 * Run one delegation via `codex exec` inside the worktree.
 *
 * Codex supplies the agent loop, tools, and sandbox; auth is whatever
 * `codex login` cached — a ChatGPT subscription session or an API key.
 * We supply the brief (prompt), the result shape (--output-schema), the
 * working root (-C worktree), and lifecycle control (timeout/cancel by
 * killing the process).
 */
export function runCodexWorker(
  spec: DispatchSpec,
  profile: WorkerProfile,
  worktreePath: string,
  cb: WorkerCallbacks = {}
): Promise<WorkerOutcome> {
  const startedAt = Date.now();
  const scratch = mkdtempSync(join(tmpdir(), "proxenos-"));
  const schemaPath = join(scratch, "output-schema.json");
  const lastMessagePath = join(scratch, "last-message.json");
  writeFileSync(schemaPath, JSON.stringify(OUTPUT_SCHEMA), "utf8");

  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "-C", worktreePath,
    "-s", profile.sandbox,
    "--output-schema", schemaPath,
    "-o", lastMessagePath,
    ...(profile.model ? ["-m", profile.model] : []),
    ...profile.extraArgs,
    buildPrompt(spec),
  ];

  const usage: Usage = {
    inputTokens: null,
    outputTokens: null,
    quota: detectQuota(),
    events: 0,
    wallTimeMs: 0,
    model: resolveModelLabel(profile),
  };

  return new Promise((resolve) => {
    // detached => codex leads its own process group, so timeout/cancel can
    // kill the whole group — otherwise shell commands codex spawned survive
    // as orphans and can keep writing into the worktree during cleanup.
    const child = spawn(profile.codexBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: true,
    });

    const killHard = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    let terminal: WorkerOutcome["terminal"] | null = null;
    let stderrTail = "";

    const settle = (t: WorkerOutcome["terminal"], finish: FinishPayload | null, error?: string) => {
      usage.wallTimeMs = Date.now() - startedAt;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      rmSync(scratch, { recursive: true, force: true });
      resolve({ finish, terminal: t, error, usage });
    };

    const timer = setTimeout(() => {
      terminal = "timeout";
      killHard();
    }, spec.constraints.timeoutMs);

    const cancelPoll = setInterval(() => {
      if (cb.isCancelled?.()) {
        terminal = "cancelled";
        killHard();
      }
    }, 500);

    child.on("error", (err) => settle("failed", null, `failed to spawn '${profile.codexBin}': ${err.message}`));

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    // Stream JSONL events for live progress (check_delegation / CLI trace).
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return; // non-JSON noise
      }
      usage.events += 1;
      const tokens = extractTokens(event);
      if (tokens) {
        usage.inputTokens = (usage.inputTokens ?? 0) + tokens.input;
        usage.outputTokens = (usage.outputTokens ?? 0) + tokens.output;
      }
      cb.onEvent?.(usage.events, describeEvent(event));
    });

    child.on("close", (code) => {
      if (terminal) return settle(terminal, null); // killed by timeout/cancel

      // Read the structured final message regardless of exit code — a failed
      // run may still have written a useful last message.
      let finish: FinishPayload | null = null;
      try {
        const raw = JSON.parse(readFileSync(lastMessagePath, "utf8"));
        finish = {
          summary: String(raw.summary ?? ""),
          obstacles: Array.isArray(raw.obstacles) ? raw.obstacles.map(String) : [],
          criteriaMet: Boolean(raw.criteriaMet),
        };
      } catch {
        // no structured output — fall through
      }

      if (code === 0 && finish) return settle("finished", finish);
      if (code === 0) {
        return settle("finished", {
          summary: "(worker produced no structured final message)",
          obstacles: ["final message did not match the output schema"],
          criteriaMet: false,
        });
      }
      settle("failed", finish, `codex exec exited ${code}. stderr tail:\n${stderrTail}`);
    });
  });
}

// --- Resolved-model reporting ------------------------------------------------
// Codex's --json stream never emits the model it ran, and proxenos uses
// --ephemeral (no session file), so we resolve the label the same way codex
// resolves the model itself: an explicit -m wins, then an extraArgs override,
// then the root `model` in ~/.codex/config.toml (the SSoT), else unknown. This
// makes delegations.jsonl record the model that actually ran, not a placeholder.
export function resolveModelLabel(profile: WorkerProfile): string {
  if (profile.model) return profile.model;

  const fromArgs = modelFromExtraArgs(profile.extraArgs);
  if (fromArgs) return fromArgs;

  const fromConfig = codexConfigModel();
  if (fromConfig) return fromConfig;

  return "codex-default";
}

function modelFromExtraArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-m" || a === "--model") return args[i + 1] ?? null;
    if (a.startsWith("--model=")) return a.slice("--model=".length);
    // codex config override, e.g. `-c model="gpt-5.5"`
    if ((a === "-c" || a === "--config") && args[i + 1]) {
      const m = /^model\s*=\s*"?([^"\s]+)"?$/.exec(args[i + 1]);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Which quota pool this run draws from, detected from codex's cached auth:
 * an OPENAI_API_KEY means platform billing; cached OAuth tokens mean the
 * ChatGPT subscription window. Never guessed — "unknown" when undeterminable.
 */
export function detectQuota(): Usage["quota"] {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  try {
    const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as {
      OPENAI_API_KEY?: string | null;
      tokens?: unknown;
    };
    if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) return "api";
    if (auth.tokens) return "chatgpt-subscription";
  } catch {
    // no readable auth.json — fall through
  }
  return "unknown";
}

function codexConfigModel(): string | null {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  try {
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    // Only the root-level `model` (before the first [table]) applies when no
    // --profile is selected, which proxenos never does. TOML requires root keys
    // to precede any table header, so stopping at the first `[` is correct.
    for (const raw of toml.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) break;
      const m = /^model\s*=\s*"([^"]+)"/.exec(line);
      if (m) return m[1];
    }
  } catch {
    // no readable config.toml — fall through to the unknown label
  }
  return null;
}

// --- JSONL event helpers (defensive: codex event shapes evolve) -------------

function extractTokens(event: Record<string, unknown>): { input: number; output: number } | null {
  const u = (event as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  if (u && (typeof u.input_tokens === "number" || typeof u.output_tokens === "number")) {
    return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
  }
  return null;
}

function describeEvent(event: Record<string, unknown>): string {
  const type = String(event.type ?? "event");
  const item = event.item as { type?: string; command?: string; path?: string; text?: string } | undefined;
  const detail = item?.command ?? item?.path ?? item?.type ?? "";
  const s = detail ? `${type}: ${detail}` : type;
  return s.length > 100 ? s.slice(0, 97) + "…" : s;
}
