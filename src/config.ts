import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ProxenosConfig, WorkerProfileSchema, WorkerProfile } from "./schemas.js";

const DEFAULT_CONFIG: ProxenosConfig = {
  workers: { default: WorkerProfileSchema.parse({}) },
};

const CANDIDATES = [
  join(process.cwd(), "proxenos.config.json"),
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "proxenos",
    "config.json"
  ),
];

export function loadConfig(): ProxenosConfig {
  for (const path of CANDIDATES) {
    if (existsSync(path)) {
      try {
        return ProxenosConfig.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch (err) {
        throw new Error(
          `Invalid proxenos config at ${path}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  return DEFAULT_CONFIG;
}

export function resolveWorker(config: ProxenosConfig, name: string): WorkerProfile {
  const profile = config.workers[name];
  if (!profile) {
    const known = Object.keys(config.workers).join(", ");
    throw new Error(`Unknown worker profile '${name}'. Known profiles: ${known}`);
  }
  return profile;
}

export function dataDir(): string {
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "proxenos"
  );
}
