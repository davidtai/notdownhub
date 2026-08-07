import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { setJobAlias, clearJobAlias } from "../lib/api";
import { Card } from "./ui/card";
import { Button } from "./ui/button";

/** What the pencil affordance opens: one job's rename state. */
export interface RenameTarget {
  /** Project the alias is scoped to (`owner/repo`). */
  project: string;
  /** The ORIGINAL job key (YAML `jobs.<key>` / engine workflowIdentifier). */
  jobKey: string;
  /** The original display name, shown as what the alias replaces. */
  original: string;
  /** The current alias, when one is set. */
  alias: string | null;
}

/**
 * The #114 rename dialog — sets a DISPLAY alias, never an override. The
 * original job name is stated in the dialog itself and stays recoverable
 * (tooltip everywhere, and "Clear alias" restores it).
 */
export function RenameJobDialog({
  target,
  onClose,
  onChanged,
}: {
  target: RenameTarget;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [value, setValue] = useState(target.alias ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const alias = value.trim();
    if (!alias || busy) return;
    setBusy(true);
    setError(null);
    const ok = await setJobAlias(target.project, target.jobKey, alias);
    setBusy(false);
    if (!ok) {
      setError("The hub refused the alias — is it reachable?");
      return;
    }
    onChanged();
    onClose();
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const ok = await clearJobAlias(target.project, target.jobKey);
    setBusy(false);
    if (!ok) {
      setError("Couldn't clear the alias — is the hub reachable?");
      return;
    }
    onChanged();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card role="dialog" aria-modal="true" aria-label={`Rename job ${target.original}`} className="w-full max-w-sm p-5">
        <h2 className="text-base font-semibold text-fg">Rename job</h2>
        <p className="mt-1.5 text-[12px] text-fg-muted">
          Display alias only — the workflow still defines{" "}
          <code className="font-mono text-fg">{target.jobKey}</code> and the original name{" "}
          <span className="font-mono text-fg">{target.original}</span> stays on hover.
        </p>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={target.original}
          autoFocus
          aria-label="Job display alias"
          className="mt-3 h-9 w-full rounded-md border border-line bg-surface px-3 text-[13px] text-fg outline-none focus:border-accent"
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        {error && (
          <p className="mt-2 flex items-start gap-1.5 rounded-md bg-fail/10 px-3 py-2 text-[12px] text-fail">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
        <div className="mt-4 flex items-center justify-between gap-2">
          {target.alias ? (
            <Button variant="outline" size="sm" onClick={clear} disabled={busy}>
              Clear alias
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={busy || !value.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
