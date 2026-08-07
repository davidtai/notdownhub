import {
  CheckCircle2,
  XCircle,
  Clock,
  CircleSlash,
  MinusCircle,
  CircleHelp,
  LoaderCircle,
} from "lucide-react";
import type { State } from "../lib/format";
import { STATE_LABEL } from "../lib/format";
import { cn } from "../lib/utils";
import { Tooltip } from "./ui/tooltip";

const COLOR: Record<State, string> = {
  success: "text-success",
  fail: "text-fail",
  running: "text-running",
  queued: "text-queued",
  cancelled: "text-skipped",
  skipped: "text-skipped",
  unknown: "text-fg-subtle",
};

/** Status glyph in its semantic color. Running spins; queued reads as a clock. */
export function StatusIcon({
  state,
  size = 16,
  withTooltip = true,
}: {
  state: State;
  size?: number;
  withTooltip?: boolean;
}) {
  const cls = COLOR[state];
  let icon;
  switch (state) {
    case "success":
      icon = <CheckCircle2 size={size} className={cls} />;
      break;
    case "fail":
      icon = <XCircle size={size} className={cls} />;
      break;
    case "running":
      icon = <LoaderCircle size={size} className={cn(cls, "spin")} />;
      break;
    case "queued":
      icon = <Clock size={size} className={cls} />;
      break;
    case "cancelled":
      icon = <CircleSlash size={size} className={cls} />;
      break;
    case "skipped":
      icon = <MinusCircle size={size} className={cls} />;
      break;
    default:
      icon = <CircleHelp size={size} className={cls} />;
  }
  if (!withTooltip) return icon;
  return (
    <Tooltip label={STATE_LABEL[state]}>
      <span className="inline-flex" aria-label={STATE_LABEL[state]}>
        {icon}
      </span>
    </Tooltip>
  );
}

const PILL: Record<State, string> = {
  success: "bg-success/12 text-success",
  fail: "bg-fail/12 text-fail",
  running: "bg-running/15 text-running",
  queued: "bg-queued/12 text-queued",
  cancelled: "bg-skipped/12 text-skipped",
  skipped: "bg-skipped/12 text-skipped",
  unknown: "bg-fg-subtle/12 text-fg-subtle",
};

/** Soft tinted status word — Passed / Failed / Running / Queued / … */
export function StatePill({ state }: { state: State }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        PILL[state],
      )}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

/** Runner liveness dot: active (filled, pulsing), idle (hollow), offline (grey hollow). */
export function RunnerStateDot({ state }: { state: "active" | "idle" | "offline" }) {
  if (state === "active") {
    return <span className="dot-pulse inline-block h-2.5 w-2.5 rounded-full bg-success" aria-hidden />;
  }
  if (state === "idle") {
    return (
      <span
        className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-success bg-transparent"
        aria-hidden
      />
    );
  }
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-fg-subtle bg-transparent"
      aria-hidden
    />
  );
}
