import { useState } from "react";
import { Ban, Trash2 } from "lucide-react";
import { cancelRun, deleteRun, type WorkflowRun } from "../lib/api";
import { toState } from "../lib/format";
import { Button } from "./ui/button";

/**
 * Cancel / delete controls for a run. Shown on the runs list row (compact, icon-only) and the
 * run detail header (labelled). A running or queued run offers Cancel (engine cancellation); a
 * finished run offers Delete behind a confirm dialog that spells out the logs are purged too.
 * `onDone` lets the parent refresh immediately so the change shows without waiting for the poll.
 */
export function RunActions({
  run,
  onDone,
  onCancelled,
  onDeleted,
  compact = false,
}: {
  run: WorkflowRun;
  /** Called after either action succeeds; a convenient single hook for the list (refresh). */
  onDone?: () => void;
  /** Called after a successful cancel (falls back to onDone). */
  onCancelled?: () => void;
  /** Called after a successful delete (falls back to onDone) — e.g. navigate away from detail. */
  onDeleted?: () => void;
  compact?: boolean;
}) {
  const state = toState(run.status, run.result);
  const canCancel = state === "running" || state === "queued";
  const canDelete = state === "success" || state === "fail" || state === "cancelled" || state === "skipped";

  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canCancel && !canDelete) return null;

  const doCancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await cancelRun(run.id);
      (onCancelled ?? onDone)?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteRun(run.id);
      setConfirming(false);
      (onDeleted ?? onDone)?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const size = compact ? "icon-sm" : "sm";
  return (
    <div className="flex items-center gap-1.5">
      {error && !confirming && (
        <span role="alert" className="text-[11px] text-fail">
          {error}
        </span>
      )}
      {canCancel && (
        <Button
          variant="outline"
          size={size}
          disabled={busy}
          onClick={doCancel}
          aria-label={`Cancel run ${run.id}`}
          title="Cancel run"
        >
          <Ban size={14} />
          {!compact && <span>Cancel</span>}
        </Button>
      )}
      {canDelete && (
        <Button
          variant="outline"
          size={size}
          disabled={busy}
          onClick={() => setConfirming(true)}
          aria-label={`Delete run ${run.id}`}
          title="Delete run"
        >
          <Trash2 size={14} />
          {!compact && <span>Delete</span>}
        </Button>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div role="dialog" aria-label="Confirm delete run" className="w-full max-w-sm rounded-lg border border-line bg-surface p-5 shadow-lg">
            <h2 className="text-sm font-semibold text-fg">Delete run #{run.id}?</h2>
            <p className="mt-2 text-[13px] text-fg-muted">
              This permanently removes the run and its persisted job logs. This can&apos;t be undone.
            </p>
            {error && (
              <p role="alert" className="mt-2 text-[12px] text-fail">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
              <Button variant="default" size="sm" disabled={busy} onClick={doDelete}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
