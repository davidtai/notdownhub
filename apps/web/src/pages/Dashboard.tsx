import { useMemo } from "react";
import { ServerCog, ListChecks, RefreshCw, TriangleAlert } from "lucide-react";
import { getRuns, getFleet } from "../lib/api";
import { toState } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { Header } from "../components/Header";
import { RunRow } from "../components/RunRow";
import { RunnerCard } from "../components/RunnerCard";
import { AddRunner } from "../components/AddRunner";
import { Card, CardHeader, CardBody } from "../components/ui/card";
import { cn } from "../lib/utils";

const RUNS_INTERVAL = 2500;
// Fleet polls briskly so a runner that joins from another terminal appears
// (with correct online/offline state) without a manual page reload.
const FLEET_INTERVAL = 3000;

export function Dashboard() {
  const runs = usePoll(() => getRuns(0), RUNS_INTERVAL);
  const fleet = usePoll(() => getFleet(), FLEET_INTERVAL);

  const runnersOnline = useMemo(
    () => (fleet.data ?? []).filter((r) => r.live).length,
    [fleet.data],
  );
  const liveRuns = useMemo(
    () => (runs.data ?? []).filter((r) => toState(r.status, r.result) === "running").length,
    [runs.data],
  );

  return (
    <div className="min-h-full">
      <Header runnersOnline={fleet.data ? runnersOnline : undefined} liveRuns={runs.data ? liveRuns : undefined} />

      <main className="mx-auto max-w-[1180px] px-5 py-6">
        <div className="mb-6">
          <p className="eyebrow">Control panel</p>
          <h1 className="mt-1 font-mono text-2xl font-bold tracking-tight text-fg">
            Your runners. Your runs.
          </h1>
          <p className="mt-1 max-w-xl text-sm text-fg-muted">
            Live status for the fleet coordinating this hub, and every workflow run it has dispatched — unmodified GitHub Actions, off GitHub.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
          {/* Recent runs */}
          <Card className="overflow-hidden">
            <CardHeader className="border-b border-line">
              <div className="flex items-center gap-2">
                <ListChecks size={15} className="text-brand" />
                <span className="eyebrow">Recent runs</span>
              </div>
              <RefreshHint loading={runs.loading} error={!!runs.error} count={runs.data?.length} />
            </CardHeader>
            {runs.initial ? (
              <SkeletonRows />
            ) : runs.error && !runs.data ? (
              <ErrorState label="Could not reach the hub. Retrying…" />
            ) : (runs.data?.length ?? 0) === 0 ? (
              <EmptyState
                title="No runs yet"
                hint="Dispatch a workflow to the fleet: ndh dispatch --server <hub>"
              />
            ) : (
              <div>
                {runs.data!.map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </div>
            )}
          </Card>

          {/* Fleet */}
          <div>
            <div className="mb-3 flex items-center gap-2 px-1">
              <ServerCog size={15} className="text-brand" />
              <span className="eyebrow">Runner fleet</span>
              {fleet.data && (
                <span className="ml-auto font-mono text-[11px] text-fg-faint">
                  {runnersOnline}/{fleet.data.length} online
                </span>
              )}
            </div>

            {fleet.initial ? (
              <div className="space-y-3">
                {[0, 1].map((i) => (
                  <div key={i} className="h-24 animate-pulse rounded-[var(--radius-card)] border border-line bg-surface" />
                ))}
              </div>
            ) : fleet.error && !fleet.data ? (
              <Card>
                <CardBody>
                  <ErrorInline label="Fleet unavailable" />
                </CardBody>
              </Card>
            ) : (fleet.data?.length ?? 0) === 0 ? (
              <Card>
                <CardBody className="py-6 text-center">
                  <p className="text-sm text-fg">No runners yet</p>
                  <p className="mt-1 text-[11px] text-fg-muted">
                    Join one with the command below — it will appear here live.
                  </p>
                </CardBody>
              </Card>
            ) : (
              <div className="space-y-3">
                {fleet.data!.map((r) => (
                  <RunnerCard key={r.id} runner={r} />
                ))}
              </div>
            )}

            <div className="mt-5">
              <AddRunner />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function RefreshHint({ loading, error, count }: { loading: boolean; error: boolean; count?: number }) {
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] text-fg-faint">
      {count !== undefined && <span>{count}</span>}
      {error ? (
        <TriangleAlert size={13} className="text-st-fail" />
      ) : (
        <RefreshCw size={12} className={cn("text-fg-faint", loading && "spin")} />
      )}
    </span>
  );
}

function SkeletonRows() {
  return (
    <div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-3.5 last:border-0">
          <div className="h-4 w-4 animate-pulse rounded-full bg-surface-2" />
          <div className="h-4 flex-1 animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-10 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="mt-1.5 font-mono text-[11px] text-fg-muted">{hint}</p>
    </div>
  );
}

function ErrorState({ label }: { label: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <ErrorInline label={label} />
    </div>
  );
}

function ErrorInline({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-st-fail">
      <TriangleAlert size={15} />
      {label}
    </span>
  );
}
