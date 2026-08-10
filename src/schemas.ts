import { z } from "zod";

// ---------------------------------------------------------------------------
// Dispatch spec — what the caller (Claude) hands to a worker.
// The .describe() strings double as prompt engineering aimed at the caller:
// MCP clients see them in the tool's input schema.
// ---------------------------------------------------------------------------

export const DispatchSpec = z.object({
  task: z
    .string()
    .min(20)
    .describe(
      "Self-contained, imperative task description. The worker has NO conversation " +
        "context and has never seen this repository — include everything it needs: " +
        "what to build/change, where, and why. Write it like a ticket for a contractor.",
    ),
  context: z.object({
    workingDir: z.string().describe("Absolute path to the git repository root to operate on."),
    seedFiles: z
      .array(z.string())
      .default([])
      .describe(
        "Repo-relative paths the worker should read before acting (entry points, " +
          "similar existing implementations, relevant tests).",
      ),
    conventions: z
      .string()
      .optional()
      .describe("Code style, naming rules, architectural patterns to follow."),
  }),
  acceptanceCriteria: z
    .array(z.string())
    .min(1)
    .describe(
      "Concrete, checkable conditions that define 'done'. The worker self-assesses " +
        "against these before finishing.",
    ),
  constraints: z
    .object({
      writeMode: z
        .enum(["patch", "direct"])
        .default("patch")
        .describe(
          "'patch': worker output is a unified diff for the caller to review and apply. " +
            "'direct': the delegation branch is left in place for the caller to merge.",
        ),
      allowedPaths: z
        .array(z.string())
        .optional()
        .describe(
          "Glob patterns (repo-relative) the worker may write to. Detection, not " +
            "containment: the worker can still attempt writes anywhere in its worktree; " +
            "violations are caught from the diff after the run and fail the delegation. " +
            "Omit to allow all.",
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(3_600_000)
        .default(600_000)
        .describe("Wall-clock limit for the worker in milliseconds. Ceiling: 1 hour."),
    })
    .prefault({}),
  verification: z
    .object({
      command: z
        .string()
        .describe(
          "Shell command run inside the worktree after the worker finishes, e.g. " +
            "'pnpm test --filter pricing'. The worktree is a fresh checkout with no " +
            "node_modules/ or other gitignored artifacts — a full test-suite command pays " +
            "a dependency install first. Prefer dependency-light commands.",
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(3_600_000)
        .default(180_000)
        .describe(
          "Wall-clock limit for the verification command; raise for long test suites. Ceiling: 1 hour.",
        ),
    })
    .optional(),
  worker: z
    .string()
    .default("default")
    .describe(
      "Named worker profile from proxenos config. Must match a profile returned by list_workers.",
    ),
});
export type DispatchSpec = z.infer<typeof DispatchSpec>;

// ---------------------------------------------------------------------------
// Result contract — what the caller gets back.
// ---------------------------------------------------------------------------

export const DelegationStatus = z.enum(["running", "completed", "failed", "timeout", "cancelled"]);
export type DelegationStatus = z.infer<typeof DelegationStatus>;

export interface FileTouched {
  path: string;
  action: "created" | "modified" | "deleted";
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  quota: "chatgpt-subscription" | "api" | "unknown";
  events: number;
  wallTimeMs: number;
  model: string;
}

export interface DelegationResult {
  status: DelegationStatus;
  summary: string;
  filesTouched: FileTouched[];
  patch: string | null;
  branch: string | null;
  verification: {
    command: string;
    exitCode: number;
    outputTail: string;
  } | null;
  obstacles: string[];
  criteriaMet: boolean | null;
  usage: Usage;
}

export interface DelegationRecord {
  id: string;
  spec: DispatchSpec;
  status: DelegationStatus;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  startedAt: string;
  finishedAt: string | null;
  events: number;
  lastAction: string;
  result: DelegationResult | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Config — worker profiles are `codex exec` invocation presets.
// Auth is whatever `codex login` cached (ChatGPT subscription or API key).
// ---------------------------------------------------------------------------

export const WorkerProfileSchema = z.object({
  model: z
    .string()
    .optional()
    .describe("Passed as `codex exec -m <model>`. Omit to use Codex's default."),
  sandbox: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  codexBin: z.string().default("codex"),
  extraArgs: z.array(z.string()).default([]),
});
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;

export const ProxenosConfig = z.object({
  workers: z.record(z.string(), WorkerProfileSchema).refine((w) => "default" in w, {
    message: "config must define a 'default' worker profile",
  }),
});

export type ProxenosConfig = z.infer<typeof ProxenosConfig>;
