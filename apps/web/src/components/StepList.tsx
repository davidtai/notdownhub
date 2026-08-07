import { useMemo } from "react";
import type { TimelineRecord } from "../lib/api";
import { toState, duration } from "../lib/format";
import { StatusIcon } from "./StatusIcon";

/**
 * Steps for the selected job, from its Timeline records. Each job's timeline
 * holds one "Job" record plus a "Task" record per step; we show the tasks in
 * their declared order with status and elapsed time.
 */
export function StepList({ records, loading }: { records: TimelineRecord[] | null; loading: boolean }) {
  const steps = useMemo(
    () =>
      (records ?? [])
        .filter((r) => r.type?.toLowerCase() === "task")
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [records],
  );

  if (loading && !records) {
    return (
      <div className="space-y-px">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 animate-pulse bg-surface-2/60" />
        ))}
      </div>
    );
  }

  if (steps.length === 0) {
    return <p className="px-3 py-6 text-center font-mono text-[11px] text-fg-muted">No steps recorded yet.</p>;
  }

  return (
    <ul>
      {steps.map((s) => {
        const state = toState(s.state, s.result);
        const d = duration(s.startTime, s.finishTime);
        return (
          <li
            key={s.id}
            className="flex items-center gap-2.5 border-b border-line px-3 py-2 last:border-0"
          >
            <StatusIcon state={state} size={14} withTooltip={false} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{s.name}</span>
            {d && <span className="shrink-0 font-mono text-[11px] text-fg-faint">{d}</span>}
          </li>
        );
      })}
    </ul>
  );
}
