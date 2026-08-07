import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { getRuns, type WorkflowRun } from "../lib/api";
import { useInfiniteList, usePersistentStrings } from "../lib/hooks";
import { filterByTerms, runHaystack } from "../lib/filter";
import { AppBar } from "../components/AppBar";
import { RunRow } from "../components/RunRow";
import { FilterInput } from "../components/FilterInput";
import { InfiniteSentinel } from "../components/InfiniteSentinel";
import { Card } from "../components/ui/card";

const RUNS_INTERVAL = 2500;
const FILTER_KEY = "ndh.filters.runs";

export function Runs() {
  // Saved filter pills persist per surface; the draft is the live, in-progress term.
  const [pills, setPills] = usePersistentStrings(FILTER_KEY);
  const [draft, setDraft] = useState("");

  // The Projects page deep-links here as /?project=<owner/repo> (its "View runs"
  // click-through). We fold that into the pill model: the project becomes a normal,
  // removable pill that composes with the rest — not a separate filter path — then
  // the query param is consumed so removing the pill sticks.
  const [searchParams, setSearchParams] = useSearchParams();
  const pillsRef = useRef(pills);
  pillsRef.current = pills;
  useEffect(() => {
    const project = searchParams.get("project");
    if (!project) return;
    if (!pillsRef.current.some((p) => p.toLowerCase() === project.toLowerCase())) {
      setPills([...pillsRef.current, project]);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("project");
    setSearchParams(next, { replace: true });
  }, [searchParams, setPills, setSearchParams]);

  // Runs load a page at a time (hub API: ?page=N) and accumulate as you scroll.
  const runs = useInfiniteList<WorkflowRun>(getRuns, (r) => r.id, RUNS_INTERVAL);
  const all = runs.items;

  const terms = useMemo(() => [...pills, draft], [pills, draft]);
  const shown = useMemo(() => filterByTerms(all, terms, runHaystack), [all, terms]);

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

        <div className="mb-4">
          <FilterInput
            pills={pills}
            onPillsChange={setPills}
            draft={draft}
            onDraftChange={setDraft}
            label="Filter runs"
            placeholder="Filter by project, workflow, branch, event, result… (Enter to save)"
          />
        </div>

        <Card className="overflow-hidden">
          {runs.initial ? (
            <SkeletonRows />
          ) : runs.error && all.length === 0 ? (
            <ErrorState />
          ) : shown.length === 0 ? (
            all.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="px-4 py-12 text-center text-sm text-fg-muted">
                No runs match these filters.
              </div>
            )
          ) : (
            <ul className="divide-y divide-line-muted">
              {shown.map((r) => (
                <li key={r.id}>
                  <RunRow run={r} onMutated={runs.refresh} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <InfiniteSentinel onVisible={runs.loadMore} disabled={runs.initial || !runs.hasMore} />
        {runs.loadingMore && (
          <p className="py-3 text-center text-[12px] text-fg-subtle">Loading more…</p>
        )}
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
