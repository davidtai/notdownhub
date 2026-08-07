import { useMemo } from "react";
import { Layers } from "lucide-react";
import type { Job } from "../lib/api";
import { toState, matrixLabel } from "../lib/format";
import { StatusIcon, WarningMarker } from "./StatusIcon";
import { cn } from "../lib/utils";

type Group =
  | { kind: "plain"; job: Job }
  | { kind: "matrix"; ident: string; parent: Job | null; legs: Job[] };

/** Group jobs by workflow identifier: a matrix parent (matrix===null) plus its legs. */
function groupJobs(jobs: Job[]): Group[] {
  const order: string[] = [];
  const byIdent = new Map<string, Job[]>();
  for (const j of jobs) {
    const k = j.workflowIdentifier || j.name;
    if (!byIdent.has(k)) {
      byIdent.set(k, []);
      order.push(k);
    }
    byIdent.get(k)!.push(j);
  }
  const groups: Group[] = [];
  for (const k of order) {
    const members = byIdent.get(k)!;
    const legs = members.filter((m) => m.matrix !== null);
    const parents = members.filter((m) => m.matrix === null);
    if (legs.length > 0) {
      groups.push({ kind: "matrix", ident: k, parent: parents[0] ?? null, legs });
    } else {
      for (const p of parents) groups.push({ kind: "plain", job: p });
    }
  }
  return groups;
}

function legLabel(job: Job): string {
  return matrixLabel(job.matrix) ?? job.name;
}

/** The run's job list. Matrix legs nest under a group header; each leg is selectable. */
export function JobList({
  jobs,
  durations,
  warnings = {},
  selectedJobId,
  onSelect,
}: {
  jobs: Job[];
  durations: Record<string, number>;
  /** Warning-signal count per jobId; a green job with >0 gets an amber marker. */
  warnings?: Record<string, number>;
  selectedJobId: string | null;
  onSelect: (job: Job) => void;
}) {
  const groups = useMemo(() => groupJobs(jobs), [jobs]);
  const longest = useMemo(
    () => Math.max(1, ...Object.values(durations)),
    [durations],
  );

  return (
    <ul className="py-1">
      {groups.map((g) => {
        if (g.kind === "plain") {
          return (
            <li key={g.job.jobId}>
              <JobRow
                job={g.job}
                label={g.job.name}
                selected={selectedJobId === g.job.jobId}
                ms={durations[g.job.jobId] ?? 0}
                warnings={warnings[g.job.jobId] ?? 0}
                longest={longest}
                onSelect={onSelect}
              />
            </li>
          );
        }
        const state = toState(g.parent?.status, g.parent?.result);
        const groupWarnings = g.legs.reduce((n, leg) => n + (warnings[leg.jobId] ?? 0), 0);
        return (
          <li key={g.ident} className="py-0.5">
            <div className="flex items-center gap-2 px-3 py-1.5 text-[13px] font-medium text-fg-muted">
              <Layers size={14} className="shrink-0 text-fg-subtle" />
              <span className="truncate">{g.parent?.name ?? g.ident}</span>
              {g.parent && <StatusIcon state={state} size={13} />}
              {state === "success" && groupWarnings > 0 && (
                <WarningMarker count={groupWarnings} size={13} />
              )}
              <span className="tnum ml-auto font-mono text-[11px] text-fg-subtle">
                {g.legs.length}
              </span>
            </div>
            <ul className="ml-3 border-l border-line pl-1">
              {g.legs.map((leg) => (
                <li key={leg.jobId}>
                  <JobRow
                    job={leg}
                    label={legLabel(leg)}
                    selected={selectedJobId === leg.jobId}
                    ms={durations[leg.jobId] ?? 0}
                    warnings={warnings[leg.jobId] ?? 0}
                    longest={longest}
                    onSelect={onSelect}
                  />
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function JobRow({
  job,
  label,
  selected,
  ms,
  warnings,
  longest,
  onSelect,
}: {
  job: Job;
  label: string;
  selected: boolean;
  ms: number;
  warnings: number;
  longest: number;
  onSelect: (job: Job) => void;
}) {
  const state = toState(job.status, job.result);
  const pct = ms > 0 ? Math.max(4, Math.round((ms / longest) * 100)) : 0;
  const dur = ms > 0 ? fmtMs(ms) : "";

  return (
    <button
      onClick={() => onSelect(job)}
      aria-current={selected}
      className={cn(
        "flex w-full items-center gap-2.5 border-l-2 px-3 py-2 text-left transition-colors",
        selected
          ? "border-accent bg-raised"
          : "border-transparent hover:bg-raised",
      )}
    >
      <StatusIcon state={state} size={15} withTooltip={false} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-[13px]", selected ? "font-medium text-fg" : "text-fg")}>
            {label}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {state === "success" && warnings > 0 && (
              <WarningMarker count={warnings} size={12} withTooltip={false} />
            )}
            {dur && <span className="tnum font-mono text-[11px] text-fg-subtle">{dur}</span>}
          </span>
        </div>
        {/* Signature: a thin proportional duration bar, relative to the run's longest job. */}
        <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-line-muted">
          <div
            className={cn("h-full rounded-full", selected ? "bg-accent/60" : "bg-fg-subtle/35")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </button>
  );
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${String(rs).padStart(2, "0")}s`;
}
