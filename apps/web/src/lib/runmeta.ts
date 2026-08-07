/*
  Run timing enrichment for the runs list (issue #96).

  The engine's runs-list payload carries no time field at all, so every row's
  time slot rendered blank. The truth lives in the hub DB's Job timeline records,
  served in batch by GET /api/local/runs-meta. This module owns the two halves:

  - useRunsMeta: page-level enrichment. Each time the loaded runs change (a new
    page arrives — including pages the #93 filter auto-search pulls in — or the
    poll refreshes), ONE batched request resolves every unsettled id. Never one
    request per row. A finished run's times are final, so its id settles and is
    never asked about again; running/queued runs are re-asked so "running for…"
    and the finish time stay live.

  - runTimeCell: the pure presentation rule for a row's time slot. Relative time
    with the absolute timestamp as the hover title; a running run reads
    "running for …"; a finished run reads finished-relative plus its duration.
    No recorded time → the honest fallback (createdOn if the engine ever sends
    it, else nothing) — a time is never fabricated.
*/

import { useEffect, useRef, useState } from "react";
import { getRunsMeta, type RunTimeMeta, type WorkflowRun } from "./api";
import { absoluteTime, elapsedMs, humanDuration, isFinished, relativeTime, toState, type State } from "./format";

/**
 * Batched run-timing map for the runs currently loaded, keyed by run id.
 * One request per change of the loaded set; finished ids resolve exactly once.
 */
export function useRunsMeta(runs: WorkflowRun[]): Record<number, RunTimeMeta> {
  const [meta, setMeta] = useState<Record<number, RunTimeMeta>>({});
  /** Ids whose meta can no longer change (finished — with or without recorded times). */
  const settled = useRef<Set<number>>(new Set());
  const inflight = useRef(false);

  useEffect(() => {
    const pending = runs.filter((r) => !settled.current.has(r.id)).map((r) => r.id);
    if (pending.length === 0 || inflight.current) return;
    const finished = new Set(runs.filter((r) => isFinished(toState(r.status, r.result))).map((r) => r.id));
    inflight.current = true;
    getRunsMeta(pending)
      .then((got) => {
        // null = endpoint unavailable/transient failure: settle nothing, retry next cycle.
        if (!got) return;
        for (const id of pending) {
          // Final either way: recorded finish, or a finished run the fleet never timed.
          if (got[id]?.finishedAt || finished.has(id)) settled.current.add(id);
        }
        setMeta((prev) => ({ ...prev, ...got }));
      })
      .finally(() => {
        inflight.current = false;
      });
  }, [runs]);

  return meta;
}

/** What a run row's time slot shows: main line, optional duration line, hover title. */
export interface TimeCell {
  primary: string;
  secondary?: string;
  title?: string;
}

/**
 * The time slot for one run row. Pure — same inputs, same cell:
 *   running + startedAt          → "running for 34s"        (title: Started <absolute>)
 *   finished + finishedAt        → "3m ago" + duration line  (title: Started · Finished)
 *   startedAt only (no finish)   → started-relative          (title: Started <absolute>)
 *   no meta                      → createdOn fallback, else null (row shows no time)
 */
export function runTimeCell(state: State, meta?: RunTimeMeta, createdOn?: string | null): TimeCell | null {
  if (meta?.startedAt) {
    const startedAbs = absoluteTime(meta.startedAt);
    if (meta.finishedAt) {
      const cell: TimeCell = {
        primary: relativeTime(meta.finishedAt),
        title: `Started ${startedAbs} · Finished ${absoluteTime(meta.finishedAt)}`,
      };
      const dur = meta.durationMs !== undefined ? humanDuration(meta.durationMs) : "";
      if (dur) cell.secondary = dur;
      return cell;
    }
    if (state === "running") {
      return { primary: `running for ${humanDuration(elapsedMs(meta.startedAt))}`, title: `Started ${startedAbs}` };
    }
    return { primary: relativeTime(meta.startedAt), title: `Started ${startedAbs}` };
  }
  const fallback = relativeTime(createdOn);
  if (!fallback) return null;
  const abs = absoluteTime(createdOn);
  return abs ? { primary: fallback, title: abs } : { primary: fallback };
}
