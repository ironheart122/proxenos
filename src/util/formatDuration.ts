/** Formats a millisecond duration as a compact human-readable string. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0ms";
  }

  if (ms < 1_000) {
    return `${ms}ms`;
  }

  if (ms < 60_000) {
    const seconds = (ms / 1_000).toFixed(1).replace(/\.0$/, "");
    return `${seconds}s`;
  }

  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
