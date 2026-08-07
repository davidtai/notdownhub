import { Link } from "react-router-dom";
import { GitBranch, GitCommitHorizontal } from "lucide-react";
import type { WorkflowRun } from "../lib/api";
import { toState, shortRef, shortSha, relativeTime, projectLabel, isFinished } from "../lib/format";
import { StatusIcon, WarningMarker } from "./StatusIcon";
import { RunActions } from "./RunActions";
import { RerunButton } from "./RerunButton";
import { Badge } from "./ui/badge";

/**
 * One row in the runs list. The row links to the run detail; the trailing actions
 * sit beside it — a Re-run for a finished run, plus cancel/delete (each
 * state-gated). `warnings` is the count of warning signals on a green run
 * (0/undefined for a clean run, or one still being resolved) — shown as an amber
 * marker so a green-but-noisy run stands out at a glance.
 */
export function RunRow({
  run,
  onMutated,
  onRerun,
  warnings = 0,
}: {
  run: WorkflowRun;
  onMutated?: () => void;
  onRerun?: () => void;
  warnings?: number;
}) {
  const state = toState(run.status, run.result);
  const ref = shortRef(run.ref);
  const sha = shortSha(run.sha);
  const repo = projectLabel(run);
  const when = relativeTime(run.createdOn);
  const title = run.displayName || run.fileName || `Run ${run.id}`;

  return (
    <div className="flex items-center gap-2 pr-3 transition-colors hover:bg-raised focus-within:bg-raised">
      <Link
        to={`/runs/${run.id}`}
        className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 focus-visible:bg-raised sm:items-center"
      >
        <span className="mt-0.5 shrink-0 sm:mt-0">
          <StatusIcon state={state} size={16} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{title}</span>
            <span className="tnum shrink-0 font-mono text-xs text-fg-subtle">#{run.id}</span>
            {state === "success" && warnings > 0 && (
              <span className="shrink-0">
                <WarningMarker count={warnings} size={13} />
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-fg-muted">
            {run.eventName && <Badge variant="outline">{run.eventName}</Badge>}
            {repo && <span className="truncate font-mono text-[11px]">{repo}</span>}
            {ref && (
              <span className="flex items-center gap-1 font-mono text-[11px]">
                <GitBranch size={11} className="text-fg-subtle" />
                {ref}
              </span>
            )}
            {sha && (
              <span className="flex items-center gap-1 font-mono text-[11px]">
                <GitCommitHorizontal size={12} className="text-fg-subtle" />
                {sha}
              </span>
            )}
          </div>
        </div>

        {when && (
          <span className="tnum mt-0.5 shrink-0 text-right text-[11px] text-fg-subtle sm:mt-0">
            {when}
          </span>
        )}
      </Link>

      {/* Trailing actions: re-run a finished run, alongside cancel/delete (each state-gated). */}
      <div className="flex shrink-0 items-center gap-1">
        {isFinished(state) && <RerunButton runId={run.id} onDone={onRerun} />}
        <RunActions run={run} onDone={onMutated} compact />
      </div>
    </div>
  );
}
