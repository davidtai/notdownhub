import { Fragment } from "react";
import { Link, useNavigate } from "react-router-dom";
import { GitBranch, GitCommitHorizontal } from "lucide-react";
import { aliasFor, type JobAlias, type RunTimeMeta, type WorkflowRun } from "../lib/api";
import { toState, shortRef, shortSha, projectLabel, isFinished, runDisplayName } from "../lib/format";
import { runTimeCell } from "../lib/runmeta";
import { StatusIcon, WarningMarker } from "./StatusIcon";
import { RunActions } from "./RunActions";
import { RerunButton } from "./RerunButton";
import { Badge } from "./ui/badge";

/**
 * One row in the runs list. The row links to the run detail; the trailing actions
 * sit beside it — a Re-run for a finished run, plus cancel/delete (each
 * state-gated). `warnings` is the count of warning signals on a green run
 * (0/undefined for a clean run, or one still being resolved) — shown as an amber
 * marker so a green-but-noisy run stands out at a glance. `meta` is the run's
 * real execution timing from the batch runs-meta endpoint (issue #96): a running
 * run reads "running for …", a finished one its finish-relative time + duration,
 * with the absolute timestamps on hover. On an IN-PROGRESS row, `meta` also
 * carries the current attempt's active jobs (#132), rendered as a compact
 * "running: …" line through the #114 alias layer (`aliases`): the alias is
 * shown, the original job name sits in the tooltip, and past two jobs the rest
 * collapse into "+N more". Finished rows never show the line.
 */
/** How many active jobs the running line spells out before "+N more". */
export const MAX_RUNNING_JOBS_SHOWN = 2;

export function RunRow({
  run,
  onMutated,
  onRerun,
  warnings = 0,
  meta,
  aliases = [],
}: {
  run: WorkflowRun;
  onMutated?: () => void;
  onRerun?: () => void;
  warnings?: number;
  meta?: RunTimeMeta;
  /** #114 display aliases (whole store; lookups are scoped to this run's project). */
  aliases?: JobAlias[];
}) {
  const navigate = useNavigate();
  const state = toState(run.status, run.result);
  const ref = shortRef(run.ref);
  const sha = shortSha(run.sha);
  const repo = projectLabel(run);
  const when = runTimeCell(state, meta, run.createdOn);
  // Honest name for a filter-skipped run: basename + "(skipped)", never the raw workflow path (#140).
  const title = runDisplayName(run);
  // #132: the current attempt's active jobs — meaningful only while the run is
  // actually in progress (stale meta on a just-finished run must not render).
  const runningJobs = state === "running" ? (meta?.runningJobs ?? []) : [];
  const shownJobs = runningJobs.slice(0, MAX_RUNNING_JOBS_SHOWN);
  const moreJobs = runningJobs.length - shownJobs.length;

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
          {/* #132: which job(s) an in-progress run is on right now, aliased (#114). */}
          {shownJobs.length > 0 && (
            <div className="mt-1 truncate text-[12px] text-fg-muted">
              <span className="text-fg-subtle">running: </span>
              {shownJobs.map((j, i) => {
                const alias = aliasFor(aliases, repo, j.key);
                return (
                  <Fragment key={`${j.key}:${j.name}`}>
                    {i > 0 && ", "}
                    <span
                      className="font-medium text-fg"
                      title={alias ? `Original: ${j.name}` : undefined}
                    >
                      {alias ?? j.name}
                    </span>
                  </Fragment>
                );
              })}
              {moreJobs > 0 && <span className="text-fg-subtle"> +{moreJobs} more</span>}
            </div>
          )}
        </div>

        {when && (
          <span
            className="tnum mt-0.5 flex shrink-0 flex-col items-end text-right text-[11px] text-fg-subtle sm:mt-0"
            title={when.title}
          >
            <span>{when.primary}</span>
            {when.secondary && <span>{when.secondary}</span>}
          </span>
        )}
      </Link>

      {/* Trailing actions: re-run a finished run, alongside cancel/delete (each state-gated). */}
      <div className="flex shrink-0 items-center gap-1">
        {isFinished(state) && (
          <RerunButton
            runId={run.id}
            onDone={() => {
              onRerun?.();
              // Land on the run so the user watches the new attempt live (the
              // detail view follows the newest attempt) instead of staying in the list.
              navigate(`/runs/${run.id}`);
            }}
          />
        )}
        <RunActions run={run} onDone={onMutated} compact />
      </div>
    </div>
  );
}
