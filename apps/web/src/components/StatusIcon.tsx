import { CheckCircle2, XCircle, Clock, MinusCircle, SlashIcon, HelpCircle, LoaderCircle } from "lucide-react";
import type { State } from "../lib/format";
import { STATE_LABEL } from "../lib/format";
import { cn } from "../lib/utils";
import { Tooltip } from "./ui/tooltip";

const COLOR: Record<State, string> = {
  success: "text-st-success",
  fail: "text-st-fail",
  running: "text-st-running",
  queued: "text-st-queued",
  cancelled: "text-st-fail",
  skipped: "text-st-skipped",
  unknown: "text-fg-faint",
};

/** Status glyph with the semantic color. Running spins; queued reads as a clock. */
export function StatusIcon({ state, size = 16, withTooltip = true }: { state: State; size?: number; withTooltip?: boolean }) {
  const cls = cn(COLOR[state]);
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
      icon = <MinusCircle size={size} className={cls} />;
      break;
    case "skipped":
      icon = <SlashIcon size={size} className={cls} />;
      break;
    default:
      icon = <HelpCircle size={size} className={cls} />;
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

/** A small filled dot for online/offline signals. */
export function SignalDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex h-2.5 w-2.5", className)}>
      <span
        className={cn(
          "inline-flex h-2.5 w-2.5 rounded-full",
          online ? "bg-st-running live-pulse" : "bg-st-queued",
        )}
      />
    </span>
  );
}
