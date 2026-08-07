import { Link } from "react-router-dom";
import { GitBranch, GitCommitHorizontal, ChevronRight } from "lucide-react";
import type { WorkflowRun } from "../lib/api";
import { toState, shortRef, shortSha } from "../lib/format";
import { StatusIcon } from "./StatusIcon";
import { Badge } from "./ui/badge";

/** A single row in the recent-runs list. The whole row links to the run detail. */
export function RunRow({ run }: { run: WorkflowRun }) {
  const state = toState(run.status, run.result);
  const ref = shortRef(run.ref);
  const sha = shortSha(run.sha);
  const repo = run.owner && run.owner !== "Unknown" ? `${run.owner}/${run.repo}` : null;

  return (
    <Link
      to={`/runs/${run.id}`}
      className="group grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-surface-2"
    >
      <StatusIcon state={state} size={17} />

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">
            {run.displayName || run.fileName || `run ${run.id}`}
          </span>
          {run.eventName && <Badge variant="outline">{run.eventName}</Badge>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-muted">
          {repo && <span className="truncate">{repo}</span>}
          {ref && (
            <span className="flex items-center gap-1">
              <GitBranch size={11} className="text-fg-faint" />
              {ref}
            </span>
          )}
          {sha && (
            <span className="flex items-center gap-1">
              <GitCommitHorizontal size={12} className="text-fg-faint" />
              {sha}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-fg-faint">#{run.id}</span>
        <ChevronRight size={15} className="text-fg-faint transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
