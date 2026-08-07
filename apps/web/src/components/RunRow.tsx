import { Link } from "react-router-dom";
import { GitBranch, GitCommitHorizontal } from "lucide-react";
import type { WorkflowRun } from "../lib/api";
import { toState, shortRef, shortSha, relativeTime, projectLabel } from "../lib/format";
import { StatusIcon } from "./StatusIcon";
import { Badge } from "./ui/badge";

/** One row in the runs list. The whole row links to the run detail. */
export function RunRow({ run }: { run: WorkflowRun }) {
  const state = toState(run.status, run.result);
  const ref = shortRef(run.ref);
  const sha = shortSha(run.sha);
  const repo = projectLabel(run);
  const when = relativeTime(run.createdOn);
  const title = run.displayName || run.fileName || `Run ${run.id}`;

  return (
    <Link
      to={`/runs/${run.id}`}
      className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-raised focus-visible:bg-raised sm:items-center"
    >
      <span className="mt-0.5 shrink-0 sm:mt-0">
        <StatusIcon state={state} size={16} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-fg">{title}</span>
          <span className="tnum shrink-0 font-mono text-xs text-fg-subtle">#{run.id}</span>
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
  );
}
