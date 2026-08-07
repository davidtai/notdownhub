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

/** A run/job in a terminal state — the only runs it makes sense to offer a re-run for. */
export function isFinished(state: State): boolean {
  return state === "success" || state === "fail" || state === "cancelled" || state === "skipped";
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

/**
 * The project a run belongs to — `owner/repo`, or whichever half the run carries.
 * Always returns a label so every run visibly belongs to a project (never hidden).
 */
export function projectLabel(run: { owner?: string | null; repo?: string | null }): string {
  const owner = run.owner?.trim();
  const repo = run.repo?.trim();
  if (owner && repo) return `${owner}/${repo}`;
  return repo || owner || "local";
}

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
  return humanDuration(b - a);
}

/** Human duration from milliseconds, e.g. "850ms", "1.2s", "3m 04s". "" if invalid. */
export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 2 : 1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Absolute local time for hover titles, e.g. "8/7/2026, 6:42:34 AM". "" if unparseable. */
export function absoluteTime(ts?: string | null): string {
  if (!ts) return "";
  const t = Date.parse(withZone(ts));
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString();
}

// The hub emits naive local timestamps (no zone). Treat them as UTC-agnostic by
// letting the browser parse them directly; only append Z if it looks bare.
function withZone(ts: string): string {
  return /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`;
}

/** Compact relative time, e.g. "just now", "3m ago", "2h ago". "" if unparseable. */
export function relativeTime(ts?: string | null): string {
  if (!ts) return "";
  const t = Date.parse(withZone(ts));
  if (!Number.isFinite(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return "just now";
  if (s < 45) return "just now";
  if (s < 90) return "1m ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/** Elapsed milliseconds between two timestamps (0 if unknown). Runs-in-progress use now(). */
export function elapsedMs(start?: string | null, finish?: string | null): number {
  if (!start) return 0;
  const a = Date.parse(withZone(start));
  const b = finish ? Date.parse(withZone(finish)) : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return b - a;
}

/** Job-level span across a timeline: earliest start → latest finish (or now if still open). */
export function timelineSpan(records: { startTime: string | null; finishTime: string | null; type?: string }[]): {
  start: string | null;
  finish: string | null;
} {
  let start: number | null = null;
  let finish: number | null = null;
  let open = false;
  for (const r of records) {
    if (r.startTime) {
      const a = Date.parse(withZone(r.startTime));
      if (Number.isFinite(a)) start = start === null ? a : Math.min(start, a);
    }
    if (r.finishTime) {
      const b = Date.parse(withZone(r.finishTime));
      if (Number.isFinite(b)) finish = finish === null ? b : Math.max(finish, b);
    } else if (r.startTime) {
      open = true;
    }
  }
  return {
    start: start === null ? null : new Date(start).toISOString(),
    finish: open || finish === null ? null : new Date(finish).toISOString(),
  };
}

/** Human byte size, e.g. "0 B", "158 B", "1.2 KB", "3.4 MB". */
export function humanSize(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
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
