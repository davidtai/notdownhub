import { useMemo } from "react";
import { Cpu, Layers, TriangleAlert } from "lucide-react";
import { getAgents, type RunnerInfo } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { AppBar } from "../components/AppBar";
import { AddRunner } from "../components/AddRunner";
import { RunnerStateDot } from "../components/StatusIcon";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

const STATE_WORD: Record<RunnerInfo["state"], string> = {
  active: "Active",
  idle: "Idle",
  offline: "Offline",
};

/** "Darwin 25.5.0 Darwin Kernel …" → "Darwin 25.5.0". */
function osShort(os?: string): string {
  if (!os) return "";
  const words = os.trim().split(/\s+/).slice(0, 2).join(" ");
  return words.length > 30 ? words.slice(0, 30) + "…" : words;
}

export function Runners() {
  const agents = usePoll(() => getAgents(), 3000);
  const list = useMemo(() => agents.data ?? [], [agents.data]);
  const activeCount = list.filter((a) => a.state !== "offline").length;

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
              {activeCount}/{list.length} online
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
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
            ) : list.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <p className="text-sm font-medium text-fg">No runners registered</p>
                <p className="mt-1 text-[13px] text-fg-muted">Join one with the command on the right.</p>
              </div>
            ) : (
              <ul className="divide-y divide-line-muted">
                {list.map((r) => (
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

          <div>
            <AddRunner />
          </div>
        </div>
      </main>
    </div>
  );
}
