import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import type { DelegationRecord } from "../schemas.js";

/**
 * Append-only JSONL log of every completed delegation: full spec + result + usage.
 * This is the observability story today and an eval dataset later — old specs can
 * be replayed against new worker models and outcomes diffed.
 */
export function persistRecord(record: DelegationRecord): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "delegations.jsonl"), JSON.stringify(record) + "\n", "utf8");
}
