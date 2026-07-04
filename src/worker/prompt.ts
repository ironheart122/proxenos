import type { DispatchSpec } from "../schemas.js";

/**
 * Render the dispatch spec into a single self-contained prompt for `codex exec`.
 * Codex brings its own tools and system behavior; our job is only the brief.
 */
export function buildPrompt(spec: DispatchSpec): string {
  const parts = [
    "You are completing a delegated task in this repository. You have no prior context — everything you need is below.",
    "",
    "## Task",
    spec.task,
    "",
    "## Acceptance criteria (self-assess against ALL of these before finishing)",
    ...spec.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
  ];
  if (spec.context.seedFiles.length) {
    parts.push("", "## Read these files first", ...spec.context.seedFiles.map((f) => `- ${f}`));
  }
  if (spec.context.conventions) {
    parts.push("", "## Repository conventions", spec.context.conventions);
  }
  if (spec.constraints.allowedPaths?.length) {
    parts.push(
      "",
      "## Write restrictions",
      `Only modify files matching: ${spec.constraints.allowedPaths.join(", ")}. ` +
        "Writes outside these paths will fail the delegation."
    );
  }
  if (spec.verification) {
    parts.push("", "## Verification", `Run this before finishing and fix failures: \`${spec.verification.command}\``);
  }
  parts.push(
    "",
    "## Final response format",
    "Your final message MUST be JSON matching the provided output schema: a short summary (<=200 words), " +
      "an `obstacles` array listing every assumption you made or issue you could not resolve " +
      "(empty if none), and `criteriaMet` — an honest boolean for whether every acceptance criterion is satisfied."
  );
  return parts.join("\n");
}

/** JSON Schema handed to `codex exec --output-schema` to shape the final message. */
export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What you did, <=200 words." },
    obstacles: {
      type: "array",
      items: { type: "string" },
      description: "Assumptions made or issues you could not resolve.",
    },
    criteriaMet: {
      type: "boolean",
      description: "Whether every acceptance criterion is satisfied.",
    },
  },
  required: ["summary", "obstacles", "criteriaMet"],
  additionalProperties: false,
} as const;
