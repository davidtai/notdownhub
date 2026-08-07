/** A normalized lifecycle state derived from the hub's status/result pair. */
export type State = "success" | "fail" | "running" | "queued" | "cancelled" | "skipped" | "unknown";

/**
 * The hub reports lifecycle two ways: `status` (queued/running/completed) and
 * `result` (succeeded/failed/…). They don't always agree — a finished job may
 * still read status "pending" while its result is "succeeded" — so a truthy
 * result always wins, and status only decides among the unfinished states.
 */
export function toState(status?: string | null, result?: string | null): State {
  const r = (result ?? "").toLowerCase();
  const s = (status ?? "").toLowerCase();
  if (r === "succeeded" || r === "success") return "success";
  if (r === "failed" || r === "failure") return "fail";
  if (r === "cancelled" || r === "canceled") return "cancelled";
  if (r === "skipped") return "skipped";
  if (s === "inprogress" || s === "in_progress" || s === "running") return "running";
  if (s === "completed" || s === "done") return "success";
  if (s === "queued" || s === "pending" || s === "waiting") return "queued";
  return "unknown";
}

export const STATE_LABEL: Record<State, string> = {
  success: "Passed",
  fail: "Failed",
  running: "Running",
  queued: "Queued",
  cancelled: "Cancelled",
  skipped: "Skipped",
  unknown: "Unknown",
};

/** First 7 of a commit sha, the way every git UI shows it. */
export function shortSha(sha?: string | null): string {
  if (!sha) return "";
  return sha.slice(0, 7);
}

/** "refs/heads/main" → "main"; tags and raw refs pass through sensibly. */
export function shortRef(ref?: string | null): string {
  if (!ref) return "";
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

/** Human duration between two ISO timestamps, e.g. "1.2s", "3m 04s". */
export function duration(start?: string | null, finish?: string | null): string {
  if (!start) return "";
  const a = Date.parse(withZone(start));
  const b = finish ? Date.parse(withZone(finish)) : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return "";
  const ms = b - a;
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 2 : 1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// The hub emits naive local timestamps (no zone). Treat them as UTC-agnostic by
// letting the browser parse them directly; only append Z if it looks bare.
function withZone(ts: string): string {
  return /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`;
}

/** Parse the hub's matrix field (a JSON string) into a compact chip label. */
export function matrixLabel(matrix?: string | null): string | null {
  if (!matrix) return null;
  try {
    const parsed = JSON.parse(matrix);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!first || typeof first !== "object") return null;
    const parts = Object.entries(first).map(([k, v]) => `${k}: ${v}`);
    return parts.length ? parts.join(" · ") : null;
  } catch {
    return null;
  }
}
