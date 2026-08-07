import { useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { getRuns, type WorkflowRun } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { AppBar } from "../components/AppBar";
import { RunRow } from "../components/RunRow";
import { Card } from "../components/ui/card";
import { projectLabel } from "../lib/format";
import { cn } from "../lib/utils";

const RUNS_INTERVAL = 2500;
const ALL = "__all__";

/** Group key for a workflow — its file, the stable identity across runs. */
function workflowKey(run: WorkflowRun): string {
  return run.fileName || run.displayName || `run-${run.id}`;
}
function workflowLabel(run: WorkflowRun): string {
  return run.displayName || run.fileName || `Run ${run.id}`;
}

export function Runs() {
  const runs = usePoll(() => getRuns(0), RUNS_INTERVAL);
  const [filter, setFilter] = useState<string>(ALL);
  const [project, setProject] = useState<string>(ALL);

  const all = useMemo(() => runs.data ?? [], [runs.data]);

  // Runs left after applying the project filter — the set the workflow filter and
  // its counts are derived from, so the two filters compose.
  const byProject = useMemo(
    () => (project === ALL ? all : all.filter((r) => projectLabel(r) === project)),
    [all, project],
  );

  const workflows = useMemo(() => {
    const map = new Map<string, { key: string; label: string; count: number }>();
    for (const r of byProject) {
      const key = workflowKey(r);
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else map.set(key, { key, label: workflowLabel(r), count: 1 });
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [byProject]);

  const projects = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of all) map.set(projectLabel(r), (map.get(projectLabel(r)) ?? 0) + 1);
    return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
  }, [all]);

  const shown = useMemo(
    () => (filter === ALL ? byProject : byProject.filter((r) => workflowKey(r) === filter)),
    [byProject, filter],
  );

  const options = [{ key: ALL, label: "All workflows", count: byProject.length }, ...workflows];

  return (
    <div className="min-h-full">
      <AppBar />

      <main className="mx-auto max-w-[1160px] px-4 py-6 sm:px-6">
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-fg">Runs</h1>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            Every workflow this hub has dispatched — unmodified GitHub Actions, off GitHub.
          </p>
        </div>

        {/* Mobile: workflow filter as a select. */}
        {workflows.length > 0 && (
          <div className="mb-4 lg:hidden">
            <label className="sr-only" htmlFor="wf-filter">
              Filter by workflow
            </label>
            <select
              id="wf-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-11 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg"
            >
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label} ({o.count})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
          {/* Desktop sidebar */}
          <aside className="hidden lg:block">
            <p className="eyebrow mb-2 px-2">Workflows</p>
            <nav className="flex flex-col gap-0.5">
              {options.map((o) => {
                const active = filter === o.key;
                return (
                  <button
                    key={o.key}
                    onClick={() => setFilter(o.key)}
                    aria-current={active}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                      active
                        ? "bg-raised font-medium text-fg"
                        : "text-fg-muted hover:bg-raised hover:text-fg",
                    )}
                  >
                    <span className="truncate">{o.label}</span>
                    <span className="tnum shrink-0 font-mono text-[11px] text-fg-subtle">
                      {o.count}
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Run list */}
          <div className="min-w-0">
            {/* Project filter — every run belongs to a project; filter across them. */}
            {projects.length > 1 && (
              <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by project">
                <span className="eyebrow mr-1">Project</span>
                {[{ key: ALL, count: all.length }, ...projects].map((p) => {
                  const active = project === p.key;
                  return (
                    <button
                      key={p.key}
                      onClick={() => setProject(p.key)}
                      aria-pressed={active}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
                        active
                          ? "border-accent bg-accent text-white"
                          : "border-line text-fg-muted hover:bg-raised hover:text-fg",
                      )}
                    >
                      <span className="truncate">{p.key === ALL ? "All projects" : p.key}</span>
                      <span className="tnum shrink-0 opacity-70">{p.count}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <Card className="overflow-hidden">
            {runs.initial ? (
              <SkeletonRows />
            ) : runs.error && !runs.data ? (
              <ErrorState />
            ) : shown.length === 0 ? (
              all.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="px-4 py-12 text-center text-sm text-fg-muted">
                  No runs for this workflow.
                </div>
              )
            ) : (
              <ul className="divide-y divide-line-muted">
                {shown.map((r) => (
                  <li key={r.id}>
                    <RunRow run={r} />
                  </li>
                ))}
              </ul>
            )}
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

function SkeletonRows() {
  return (
    <ul className="divide-y divide-line-muted">
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3.5">
          <div className="h-4 w-4 animate-pulse rounded-full bg-raised" />
          <div className="h-4 flex-1 animate-pulse rounded bg-raised" />
          <div className="h-3 w-12 animate-pulse rounded bg-raised" />
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-sm font-medium text-fg">No runs yet</p>
      <p className="mt-1.5 text-[13px] text-fg-muted">Dispatch one to get started:</p>
      <code className="mt-2 inline-block rounded-md bg-raised px-2.5 py-1 font-mono text-[12px] text-fg">
        ndh dispatch --server &lt;hub&gt;
      </code>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="px-6 py-16 text-center">
      <span className="inline-flex items-center gap-2 text-sm text-fail">
        <TriangleAlert size={16} />
        Couldn&apos;t reach the hub. Retrying…
      </span>
    </div>
  );
}
