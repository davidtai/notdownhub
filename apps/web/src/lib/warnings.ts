/*
  "Passed with warnings" detection.

  A green run can still hide trouble: a `##[warning]` (deprecation notice), or a
  non-fatal step failure that didn't fail the job (a cache-save 403, a
  `continue-on-error` step, a retry that exhausted its attempts). GitHub surfaces
  all of these as inline *annotations*; so do we.

  The engine already models this the standard way: every timeline record carries
  an `issues` array — `{ type: "warning" | "error" | "notice", message, data }` —
  populated by the runner (a `::warning::` becomes a warning issue; a step's
  process-exit failure becomes an error issue, even when `continue-on-error` keeps
  the job green). We read those issues directly. We never scrape `##[warning]` text
  out of the raw console: the annotation is the source of truth and the log line is
  a rendering of it.

  What counts as a warning signal, for a run/job that *succeeded*:
    • warning issues  — `##[warning]`, deprecations, cache-save warnings, …
    • error   issues  — a step that failed but did NOT fail the job (the #62 case)
  Notice issues (`::notice::`) are informational and are NOT counted.
*/

import { useEffect, useRef, useState } from "react";
import {
  getAttempts,
  getJobs,
  getTimeline,
  type Issue,
  type TimelineRecord,
  type WorkflowRun,
} from "./api";
import { toState } from "./format";

export interface Annotation {
  /** "error" is a non-fatal failure on a run that still succeeded. */
  type: "warning" | "error";
  message: string;
  /** The step (timeline record) the annotation was raised on. */
  stepName: string;
  /** 1-based step index from the engine, when present. */
  stepNumber: number | null;
}

/** Is this issue a warning signal we surface (warning or non-fatal error)? */
function annotationType(issue: Issue): "warning" | "error" | null {
  const t = (issue.type ?? "").toLowerCase();
  if (t === "warning") return "warning";
  if (t === "error") return "error";
  return null; // notice / unknown → not a warning signal
}

/**
 * Extract every warning/non-fatal-error annotation from one job's timeline
 * records. Pure: the same records always yield the same annotations, in timeline
 * order. Records with no issues contribute nothing, so a genuinely clean job
 * returns `[]` (no false positives).
 */
export function collectAnnotations(records: TimelineRecord[]): Annotation[] {
  const out: Annotation[] = [];
  for (const r of records) {
    for (const issue of r.issues ?? []) {
      const type = annotationType(issue);
      if (!type) continue;
      const raw = issue.data?.stepNumber;
      const n = raw != null && raw !== "" ? Number(raw) : NaN;
      out.push({
        type,
        message: (issue.message ?? "").trim() || "(no message)",
        stepName: r.name ?? "",
        stepNumber: Number.isFinite(n) ? n : null,
      });
    }
  }
  return out;
}

/** Number of warning signals across a job's timeline (never negative). */
export function countAnnotations(records: TimelineRecord[]): number {
  return collectAnnotations(records).length;
}

/** True when a single step/record carries at least one warning signal. */
export function hasWarnings(record: TimelineRecord): boolean {
  for (const issue of record.issues ?? []) {
    if (annotationType(issue)) return true;
  }
  return false;
}

/**
 * Resolve the total warning-signal count for a completed run, via the standard
 * timeline endpoints: attempts → latest attempt's jobs → each job's timeline.
 * Any single timeline that fails to load contributes 0 rather than throwing, so
 * one flaky job never hides the rest of the run's warnings.
 */
export async function fetchRunWarningCount(runId: number): Promise<number> {
  const attempts = await getAttempts(runId);
  if (attempts.length === 0) return 0;
  const latest = Math.max(...attempts.map((a) => a.attempt));
  const jobs = await getJobs(runId, latest);
  const counts = await Promise.all(
    jobs.map((j) => getTimeline(j.timeLineId).then(countAnnotations).catch(() => 0)),
  );
  return counts.reduce((a, b) => a + b, 0);
}

/**
 * For the runs currently shown, lazily resolve a warning count per SUCCESS run.
 * A completed run's annotations never change, so each is fetched exactly once and
 * cached by run id; the value survives the runs list's polling re-renders. Only
 * successful runs are probed — a failed run already reads "Failed", and a running
 * one has nothing final to report — which bounds the extra requests to the green
 * runs on screen. Returns `{ [runId]: count }`; a run absent from the map is
 * simply not resolved yet.
 */
export function useRunWarnings(runs: WorkflowRun[]): Record<number, number> {
  const [counts, setCounts] = useState<Record<number, number>>({});
  const inflight = useRef<Set<number>>(new Set());

  useEffect(() => {
    for (const run of runs) {
      if (toState(run.status, run.result) !== "success") continue;
      if (run.id in counts || inflight.current.has(run.id)) continue;
      inflight.current.add(run.id);
      fetchRunWarningCount(run.id)
        .then((n) => setCounts((prev) => ({ ...prev, [run.id]: n })))
        .catch(() => setCounts((prev) => ({ ...prev, [run.id]: 0 })))
        .finally(() => inflight.current.delete(run.id));
    }
  }, [runs, counts]);

  return counts;
}
