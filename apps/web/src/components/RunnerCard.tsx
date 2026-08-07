import { Cpu, Layers } from "lucide-react";
import type { Runner } from "../lib/api";
import { SignalDot } from "./StatusIcon";
import { Badge } from "./ui/badge";

/** Shorten a verbose OS description (e.g. "Darwin 25.5.0 Darwin Kernel …") to "Darwin 25.5.0". */
function osShort(os?: string): string {
  if (!os) return "unknown os";
  const words = os.trim().split(/\s+/).slice(0, 2).join(" ");
  return words.length > 28 ? words.slice(0, 28) + "…" : words;
}

/** One "bay" in the fleet — a runner's identity and live/idle signal. */
export function RunnerCard({ runner }: { runner: Runner }) {
  const online = !!runner.live;
  // The Agent read API omits labels; render them only on the rare chance they appear.
  const labels = (runner.labels ?? []).map((l) => l.name).filter(Boolean) as string[];
  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius-card)] border border-line bg-surface p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Cpu size={15} className="shrink-0 text-fg-faint" />
          <span className="truncate font-mono text-[13px] font-semibold text-fg">
            {runner.name ?? `agent ${runner.id}`}
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-faint">
          <SignalDot online={online} />
          {online ? "online" : "offline"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge>{osShort(runner.osDescription)}</Badge>
        {runner.version && <Badge variant="plain">v{runner.version}</Badge>}
        {runner.ephemeral && <Badge variant="plain">ephemeral</Badge>}
        {runner.maxParallelism ? (
          <Badge variant="plain" className="inline-flex items-center gap-1">
            <Layers size={10} />
            {runner.maxParallelism}× capacity
          </Badge>
        ) : null}
      </div>

      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {labels.map((l) => (
            <Badge key={l} variant="solid">
              {l}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
