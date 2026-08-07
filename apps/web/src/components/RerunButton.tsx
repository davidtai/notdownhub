import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { rerunWorkflow } from "../lib/api";
import { Button, type ButtonProps } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { cn } from "../lib/utils";

/**
 * Re-run a finished run on the fleet. Calls the hub's native re-run, which
 * re-queues the recorded workflow as a new attempt of the SAME run (so it stays
 * attributed to the same project and linked to the original). `onDone` fires
 * after a successful POST so the caller can refresh — the new attempt then shows
 * up in the run's attempt list.
 *
 * Used both on a run row (inside a row that is otherwise a link) and on the run
 * detail header, so the click is stopped from bubbling to any wrapping <Link>.
 */
export function RerunButton({
  runId,
  onDone,
  variant = "outline",
  size = "sm",
  className,
}: {
  runId: number;
  onDone?: () => void;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onClick(e: React.MouseEvent) {
    // The runs list wraps each row in a <Link>; keep a re-run from navigating.
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await rerunWorkflow(runId);
      onDone?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const label = failed
    ? "Re-run failed — is the hub reachable?"
    : "Re-run this workflow on the fleet (new attempt of this run)";

  return (
    <Tooltip label={label} side="bottom">
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={onClick}
        disabled={busy}
        aria-label={`Re-run run ${runId}`}
        className={cn(failed && "text-fail", className)}
      >
        <RotateCcw size={14} className={cn(busy && "spin")} aria-hidden />
        <span>{busy ? "Re-running…" : "Re-run"}</span>
      </Button>
    </Tooltip>
  );
}
