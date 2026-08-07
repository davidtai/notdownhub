import { useCallback, useMemo, useState } from "react";
import { Cpu, Layers, Trash2, TriangleAlert, X } from "lucide-react";
import { getAgents, removeAgent, type RunnerInfo } from "../lib/api";
import { usePersistentStrings, usePoll } from "../lib/hooks";
import { filterByTerms, runnerHaystack } from "../lib/filter";
import { AppBar } from "../components/AppBar";
import { AddRunner } from "../components/AddRunner";
import { FilterInput } from "../components/FilterInput";
import { InfiniteSentinel } from "../components/InfiniteSentinel";
import { RunnerStateDot } from "../components/StatusIcon";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

const STATE_WORD: Record<RunnerInfo["state"], string> = {
  active: "Active",
  idle: "Idle",
  offline: "Offline",
};

// The hub's /api/local/agents endpoint returns the whole fleet in one shot (no
// server paging), so the list is windowed client-side: reveal a page at a time.
const RUNNERS_PAGE = 12;
const FILTER_KEY = "ndh.filters.runners";

/** "Darwin 25.5.0 Darwin Kernel …" → "Darwin 25.5.0". */
function osShort(os?: string): string {
  if (!os) return "";
  const words = os.trim().split(/\s+/).slice(0, 2).join(" ");
  return words.length > 30 ? words.slice(0, 30) + "…" : words;
}

/**
 * Confirm + perform an agent removal. Copy reflects verified hub behavior: the DELETE
 * unregisters the agent (the row disappears at once), but does NOT touch the runner's
 * machine — a listener still running there keeps running and will not re-register on its
 * own, so its instance directory is cleaned separately with `ndh runner remove`.
 */
function RemoveDialog({
  runner,
  onClose,
  onRemoved,
}: {
  runner: RunnerInfo;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (runner.poolId == null) {
      setError("This hub did not report the runner's pool, so it can't be unregistered from here. Use `ndh runner remove` on the runner's machine.");
      return;
    }
    setRemoving(true);
    setError(null);
    try {
      await removeAgent(runner.poolId, runner.id);
      onRemoved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRemoving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={removing ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-runner-title"
        className="w-full max-w-md rounded-lg border border-line bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="remove-runner-title" className="text-base font-semibold text-fg">
            Remove runner
          </h2>
          <button
            aria-label="Close"
            onClick={onClose}
            disabled={removing}
            className="rounded p-1 text-fg-subtle hover:bg-raised hover:text-fg disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-3 space-y-2.5 text-[13px] text-fg-muted">
          <p>
            Unregister <span className="font-mono font-medium text-fg">{runner.name}</span> from this hub? It disappears
            from the list right away.
          </p>
          <p>
            This only removes it from the hub. It does not touch the runner&apos;s machine: if the listener is still
            running there it keeps running (idle, receiving no work) and won&apos;t reappear here on its own.
          </p>
          <p>
            To stop the listener and delete its instance directory, run{" "}
            <code className="rounded bg-raised px-1 py-0.5 font-mono text-[12px] text-fg">
              ndh runner remove {runner.name}
            </code>{" "}
            on that machine.
          </p>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-fail/30 bg-fail/10 px-3 py-2 text-[12px] text-fail">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span className="break-words">Couldn&apos;t remove the runner: {error}</span>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={removing}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={confirm}
            disabled={removing}
            className="bg-fail text-white hover:brightness-110"
          >
            {removing ? "Removing…" : "Remove"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Runners() {
  const agents = usePoll(() => getAgents(), 3000);
  const listAll = useMemo(() => agents.data ?? [], [agents.data]);
  const activeCount = listAll.filter((a) => a.state !== "offline").length;
  const [pending, setPending] = useState<RunnerInfo | null>(null);

  const [pills, setPills] = usePersistentStrings(FILTER_KEY);
  const [draft, setDraft] = useState("");
  const terms = useMemo(() => [...pills, draft], [pills, draft]);
  const filtered = useMemo(
    () => filterByTerms(listAll, terms, runnerHaystack),
    [listAll, terms],
  );

  // Client-side windowing over the filtered set — the sentinel grows the window.
  const [visible, setVisible] = useState(RUNNERS_PAGE);
  const shown = filtered.slice(0, visible);
  const hasMore = filtered.length > shown.length;
  const loadMore = useCallback(() => setVisible((v) => v + RUNNERS_PAGE), []);

  return (
    <div className="min-h-full">
      <AppBar />

      <main className="mx-auto max-w-[1160px] px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-fg">Runners</h1>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              Machines registered to this hub and their live state.
            </p>
          </div>
          {agents.data && (
            <span className="tnum shrink-0 font-mono text-[12px] text-fg-subtle">
              {activeCount}/{listAll.length} online
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
          <div className="min-w-0">
            <div className="mb-4">
              <FilterInput
                pills={pills}
                onPillsChange={setPills}
                draft={draft}
                onDraftChange={setDraft}
                label="Filter runners"
                placeholder="Filter by name, label, state… (Enter to save)"
              />
            </div>

            <Card className="overflow-hidden">
              {agents.initial ? (
                <ul className="divide-y divide-line-muted">
                  {[0, 1].map((i) => (
                    <li key={i} className="flex items-center gap-3 px-4 py-4">
                      <div className="h-2.5 w-2.5 animate-pulse rounded-full bg-raised" />
                      <div className="h-4 flex-1 animate-pulse rounded bg-raised" />
                    </li>
                  ))}
                </ul>
              ) : agents.error && !agents.data ? (
                <div className="px-6 py-14 text-center">
                  <span className="inline-flex items-center gap-2 text-sm text-fail">
                    <TriangleAlert size={16} />
                    Couldn&apos;t load runners.
                  </span>
                </div>
              ) : listAll.length === 0 ? (
                <div className="px-6 py-14 text-center">
                  <p className="text-sm font-medium text-fg">No runners registered</p>
                  <p className="mt-1 text-[13px] text-fg-muted">Join one with the command on the right.</p>
                </div>
              ) : shown.length === 0 ? (
                <div className="px-6 py-14 text-center text-sm text-fg-muted">
                  No runners match these filters.
                </div>
              ) : (
                <ul className="divide-y divide-line-muted">
                  {shown.map((r) => (
                    <li key={r.id} className="flex items-start gap-3 px-4 py-3.5">
                      <span className="mt-1 shrink-0">
                        <RunnerStateDot state={r.state} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Cpu size={14} className="shrink-0 text-fg-subtle" />
                          <span className="truncate font-mono text-[13px] font-medium text-fg">{r.name}</span>
                          <span className="ml-auto shrink-0 text-[12px] font-medium text-fg-muted">
                            {STATE_WORD[r.state]}
                          </span>
                          <button
                            aria-label={`Remove ${r.name}`}
                            title="Remove runner"
                            onClick={() => setPending(r)}
                            className="shrink-0 rounded p-1 text-fg-subtle transition-colors hover:bg-fail/10 hover:text-fail"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-fg-muted">
                          {osShort(r.os) && <span className="font-mono">{osShort(r.os)}</span>}
                          {r.version && <span className="font-mono text-fg-subtle">v{r.version}</span>}
                          {r.maxParallelism ? (
                            <span className="flex items-center gap-1 font-mono text-fg-subtle">
                              <Layers size={11} />
                              {r.maxParallelism}×
                            </span>
                          ) : null}
                          {r.ephemeral && <span className="font-mono text-fg-subtle">ephemeral</span>}
                        </div>
                        {r.labels.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {r.labels.map((l) => (
                              <Badge key={l} variant="solid" className="font-mono">
                                {l}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <InfiniteSentinel onVisible={loadMore} disabled={agents.initial || !hasMore} />
          </div>

          <div>
            <AddRunner />
          </div>
        </div>
      </main>

      {pending && (
        <RemoveDialog
          runner={pending}
          onClose={() => setPending(null)}
          onRemoved={() => {
            setPending(null);
            agents.refresh();
          }}
        />
      )}
    </div>
  );
}
