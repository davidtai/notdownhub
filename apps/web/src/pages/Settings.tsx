import { Fragment, useMemo, useState } from "react";
import { KeyRound, Variable, Lock, Tag, TriangleAlert, Trash2, Info, Filter } from "lucide-react";
import {
  getConfig,
  getProjects,
  addSecret,
  deleteSecret,
  addVar,
  deleteVar,
  validEnvName,
  type WriteResult,
} from "../lib/api";
import { usePoll, usePersistentString } from "../lib/hooks";
import {
  ALL,
  GLOBAL,
  compareScopes,
  distinctScopes,
  filterByScope,
  groupByScope,
  isRepoSlug,
  projectScopeOptions,
} from "../lib/scopes";
import { AppBar } from "../components/AppBar";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

/** localStorage key for the persisted scope filter — settings-only, distinct from the runs/runners pill keys. */
const SCOPE_FILTER_KEY = "ndh.filters.settings-scope";
/** Add-form select value that reveals the free-text repository field (typed / "other"). */
const OTHER = "repo";

function scopeLabel(scope: string): string {
  return scope === GLOBAL ? "global" : scope;
}

/** The CLI's invalid-name message, mirrored so the form and `ndh` agree word-for-word. */
function badNameMsg(name: string): string {
  return `invalid name '${name}' — use letters, digits, and underscore; must not start with a digit`;
}

export function Settings() {
  const cfg = usePoll(() => getConfig(), 5000);
  // Known projects (#91 aggregate) feed the add-form picker; polled slowly since the
  // set changes on a new dispatch, not per view. Returns null on an older hub → no options.
  const projectsPoll = usePoll(getProjects, 30_000);
  const data = cfg.data;
  const secrets = useMemo(() => data?.secrets ?? [], [data]);
  const vars = useMemo(() => data?.vars ?? [], [data]);
  const projectOptions = useMemo(() => projectScopeOptions(projectsPoll.data ?? null), [projectsPoll.data]);

  // The scope filter is shared by both lists and persists across visits.
  const [scopeFilter, setScopeFilter] = usePersistentString(SCOPE_FILTER_KEY, ALL);

  // Every scope present across the two lists (global-first), plus a stale saved
  // selection so a filter set on a now-deleted scope stays visible and resettable.
  const scopeUniverse = useMemo(() => {
    const set = new Set<string>([...distinctScopes(secrets), ...distinctScopes(vars)]);
    if (scopeFilter !== ALL) set.add(scopeFilter);
    return [...set].sort(compareScopes);
  }, [secrets, vars, scopeFilter]);

  return (
    <div className="min-h-full">
      <AppBar />

      <main className="mx-auto max-w-[1160px] px-4 py-6 sm:px-6">
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-fg">Secrets and variables</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-fg-muted">
            Values injected into workflow runs dispatched from this hub. Secret values are
            write-only — once stored, they are never shown here.
          </p>
        </div>

        {cfg.error && !data ? (
          <Card>
            <div className="px-6 py-12 text-center">
              <span className="inline-flex items-center gap-2 text-sm text-fail">
                <TriangleAlert size={16} />
                Couldn&apos;t load configuration.
              </span>
            </div>
          </Card>
        ) : (
          <div className="flex flex-col gap-6">
            <DispatchRealityNote />

            {/* Shared scope filter — narrows both lists at once. Only shown when
                there is more than one scope to choose between. */}
            {scopeUniverse.length > 1 && (
              <ScopeFilter
                value={scopeFilter}
                onChange={setScopeFilter}
                scopes={scopeUniverse}
              />
            )}

            {/* Secrets */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <KeyRound size={15} className="text-accent" />
                  <h2 className="text-sm font-semibold text-fg">Secrets</h2>
                  {data && (
                    <Badge variant="solid" className="font-mono">
                      {data.backend}
                    </Badge>
                  )}
                </span>
              </div>
              <Card className="overflow-hidden">
                {cfg.initial ? (
                  <SkeletonRows />
                ) : secrets.length === 0 ? (
                  <EmptyRow
                    icon={<Lock size={14} />}
                    label="No secrets stored."
                    example="ndh secrets set <NAME>"
                  />
                ) : (
                  <ScopedTable
                    items={secrets}
                    scopeFilter={scopeFilter}
                    noun="secret"
                    renderValue={() => (
                      <span className="inline-flex items-center gap-1.5">
                        <Lock size={12} />
                        hidden
                      </span>
                    )}
                    renderDelete={(s) => (
                      <DeleteSecretButton name={s.name} scope={s.scope} onDone={cfg.refresh} />
                    )}
                  />
                )}
                {!cfg.initial && (
                  <AddEntryForm kind="secret" projectOptions={projectOptions} onDone={cfg.refresh} />
                )}
              </Card>
            </section>

            {/* Variables */}
            <section>
              <div className="mb-2 flex items-center gap-2">
                <Variable size={15} className="text-accent" />
                <h2 className="text-sm font-semibold text-fg">Variables</h2>
              </div>
              <Card className="overflow-hidden">
                {cfg.initial ? (
                  <SkeletonRows />
                ) : vars.length === 0 ? (
                  <EmptyRow
                    icon={<Tag size={14} />}
                    label="No variables stored."
                    example="ndh vars set <NAME> <value>"
                  />
                ) : (
                  <ScopedTable
                    items={vars}
                    scopeFilter={scopeFilter}
                    noun="variable"
                    renderValue={(v) => (
                      <span className="block max-w-0 truncate font-mono text-fg-muted">{v.value}</span>
                    )}
                    renderDelete={(v) => (
                      <DeleteVarButton name={v.name} scope={v.scope} onDone={cfg.refresh} />
                    )}
                  />
                )}
                {!cfg.initial && (
                  <AddEntryForm kind="var" projectOptions={projectOptions} onDone={cfg.refresh} />
                )}
              </Card>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

/** The shared scope filter: pick "all", global, or one project the values are pinned to. */
function ScopeFilter({
  value,
  onChange,
  scopes,
}: {
  value: string;
  onChange: (v: string) => void;
  scopes: string[];
}) {
  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="scope-filter"
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg-muted"
      >
        <Filter size={14} className="text-fg-subtle" aria-hidden />
        Scope
      </label>
      <select
        id="scope-filter"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Filter by scope"
        className="h-8 rounded-md border border-line bg-surface px-2 text-[12px] text-fg focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <option value={ALL}>All scopes</option>
        {scopes.map((s) => (
          <option key={s} value={s}>
            {scopeLabel(s)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * A secret/variable list rendered as one table, its rows grouped under scope
 * headers (global first, then each owner/repo) and narrowed by the shared scope
 * filter. The per-row scope column is dropped — the group header carries the
 * scope — so a row shows just its name, value, and delete control.
 */
function ScopedTable<T extends { scope: string; name: string }>({
  items,
  scopeFilter,
  noun,
  renderValue,
  renderDelete,
}: {
  items: T[];
  scopeFilter: string;
  noun: "secret" | "variable";
  renderValue: (item: T) => React.ReactNode;
  renderDelete: (item: T) => React.ReactNode;
}) {
  const shown = useMemo(() => filterByScope(items, scopeFilter), [items, scopeFilter]);
  const groups = useMemo(() => groupByScope(shown), [shown]);

  if (shown.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-[13px] text-fg-muted" role="status">
        No {noun}s scoped to <span className="font-mono text-fg">{scopeLabel(scopeFilter)}</span>.
      </div>
    );
  }

  return (
    <table className="w-full text-left text-[13px]">
      <THead cols={["Name", "Value", ""]} />
      <tbody className="divide-y divide-line-muted">
        {groups.map((g) => (
          <Fragment key={g.scope}>
            <tr className="bg-raised/40">
              <td colSpan={3} className="px-4 py-1.5">
                <span className="inline-flex items-center gap-2">
                  <Badge variant="outline">{scopeLabel(g.scope)}</Badge>
                  <span className="text-[11px] text-fg-subtle">
                    {g.items.length} {noun}
                    {g.items.length === 1 ? "" : "s"}
                  </span>
                </span>
              </td>
            </tr>
            {g.items.map((it) => (
              <tr key={`${it.scope}/${it.name}`} className="hover:bg-raised">
                <Td className="font-mono text-fg">{it.name}</Td>
                <Td className="font-mono text-fg-subtle">{renderValue(it)}</Td>
                <Td className="w-12 text-right">{renderDelete(it)}</Td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The #47/#102 reality, stated where the forms are: values resolve on the machine that
 * DISPATCHES a run, and this page edits the hub host's store — so it affects hook and
 * schedule runs dispatched from this host, not a laptop dispatching remotely.
 */
function DispatchRealityNote() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-line bg-raised/50 px-4 py-3 text-[12.5px] text-fg-muted">
      <Info size={15} className="mt-0.5 shrink-0 text-accent" />
      <p>
        Secrets and variables resolve on the <span className="font-medium text-fg">dispatching machine</span>.
        Values managed here live on this hub host and are used by runs dispatched from it — hook and
        schedule runs. A laptop dispatching remotely still uses its own local store.{" "}
        <a
          className="text-accent hover:underline"
          href="https://github.com/davidtai/notdownhub/blob/main/docs/collaboration.md#where-secrets-live-and-why"
          target="_blank"
          rel="noreferrer"
        >
          How values reach a run
        </a>
      </p>
    </div>
  );
}

/**
 * Add-secret / add-variable form. Writes through the gated /api/local endpoints, which call
 * the same store the CLI uses. The value is sent EXACTLY as typed (byte-exact, like piped
 * stdin — #135): no newline is added or removed, so a trailing newline exists only if typed.
 *
 * The scope selector is a project PICKER (#148): global (default), each known project from
 * the #91 aggregate, then "Other repository…" for a typed owner/name fallback.
 */
function AddEntryForm({
  kind,
  projectOptions,
  onDone,
}: {
  kind: "secret" | "var";
  projectOptions: string[];
  onDone: () => void;
}) {
  const isSecret = kind === "secret";
  const noun = isSecret ? "secret" : "variable";
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  // The select value IS the scope, except for two sentinels: GLOBAL and OTHER (typed).
  const [scopeKind, setScopeKind] = useState<string>(GLOBAL);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!validEnvName(name)) {
      setError(badNameMsg(name));
      return;
    }
    if (value === "") {
      setError(`empty ${noun} value`);
      return;
    }
    // global → GLOBAL; the "other" sentinel → the typed slug; anything else is a picked project.
    const scope = scopeKind === GLOBAL ? GLOBAL : scopeKind === OTHER ? repo.trim() : scopeKind;
    if (scopeKind === OTHER && !isRepoSlug(scope)) {
      setError("repository scope must be owner/name");
      return;
    }
    setBusy(true);
    try {
      const r: WriteResult = isSecret ? await addSecret(name, value, scope) : await addVar(name, value, scope);
      if (!r.ok) {
        setError(r.error ?? `HTTP ${r.status}`);
        return;
      }
      setName("");
      setValue("");
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="border-t border-line px-4 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={`New ${noun} name`}
          placeholder={isSecret ? "NAME (e.g. NPM_TOKEN)" : "NAME (e.g. DEPLOY_TARGET)"}
          spellCheck={false}
          className="h-8 w-48 rounded-md border border-line bg-surface px-2.5 font-mono text-[12px] text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {isSecret ? (
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="New secret value"
            placeholder="value (multiline is safe — e.g. a PEM key)"
            rows={value.includes("\n") ? 4 : 1}
            spellCheck={false}
            className="min-h-8 min-w-64 flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[12px] text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-accent"
          />
        ) : (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="New variable value"
            placeholder="value (visible — variables are not secret)"
            spellCheck={false}
            className="h-8 min-w-64 flex-1 rounded-md border border-line bg-surface px-2.5 font-mono text-[12px] text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-accent"
          />
        )}
        <select
          value={scopeKind}
          onChange={(e) => setScopeKind(e.target.value)}
          aria-label={`New ${noun} scope`}
          className="h-8 rounded-md border border-line bg-surface px-2 text-[12px] text-fg focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value={GLOBAL}>global</option>
          {projectOptions.length > 0 && (
            <optgroup label="Projects">
              {projectOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </optgroup>
          )}
          <option value={OTHER}>Other repository…</option>
        </select>
        {scopeKind === OTHER && (
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            aria-label={`New ${noun} repository (owner/name)`}
            placeholder="owner/name"
            spellCheck={false}
            className="h-8 w-40 rounded-md border border-line bg-surface px-2.5 font-mono text-[12px] text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-accent"
          />
        )}
        <Button type="submit" variant="outline" size="sm" disabled={busy}>
          {isSecret ? "Add secret" : "Add variable"}
        </Button>
      </div>
      {isSecret && (
        <p className="mt-1.5 text-[11px] text-fg-subtle">
          Stored exactly as typed — a trailing newline is part of the value only if you type one.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-fail">
          {error}
        </p>
      )}
    </form>
  );
}

/** Per-row secret delete, behind a confirm dialog (a secret value is gone for good). */
function DeleteSecretButton({ name, scope, onDone }: { name: string; scope: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await deleteSecret(name, scope);
      if (!r.ok) {
        setError(r.error ?? `HTTP ${r.status}`);
        return;
      }
      setConfirming(false);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete secret ${name} (${scopeLabel(scope)})`}
        title="Delete secret"
        onClick={() => setConfirming(true)}
      >
        <Trash2 size={14} />
      </Button>
      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-label="Confirm delete secret"
            className="w-full max-w-sm rounded-lg border border-line bg-surface p-5 text-left shadow-lg"
          >
            <h2 className="text-sm font-semibold text-fg">
              Delete secret <span className="font-mono">{name}</span>?
            </h2>
            <p className="mt-2 text-[13px] text-fg-muted">
              Scope: <span className="font-mono">{scopeLabel(scope)}</span>. Runs dispatched from
              this hub can no longer resolve it, and the value can&apos;t be recovered.
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
    </>
  );
}

/** Per-row variable delete — no confirm (the value stays visible right up to the click). */
function DeleteVarButton({ name, scope, onDone }: { name: string; scope: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await deleteVar(name, scope);
      if (!r.ok) {
        setError(r.error ?? `HTTP ${r.status}`);
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      {error && (
        <span role="alert" className="text-[11px] text-fail">
          {error}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete variable ${name} (${scopeLabel(scope)})`}
        title="Delete variable"
        disabled={busy}
        onClick={doDelete}
      >
        <Trash2 size={14} />
      </Button>
    </span>
  );
}

function THead({ cols }: { cols: string[] }) {
  return (
    <thead>
      <tr className="border-b border-line">
        {cols.map((c, i) => (
          <th
            key={`${c}-${i}`}
            className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle"
          >
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 align-middle ${className ?? ""}`}>{children}</td>;
}

/** Empty state: the form right below is the primary path now; the CLI copy is secondary. */
function EmptyRow({ icon, label, example }: { icon: React.ReactNode; label: string; example: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <span className="inline-flex items-center gap-2 text-[13px] text-fg-muted">
        <span className="text-fg-subtle">{icon}</span>
        {label} Add one with the form below.
      </span>
      <p className="mx-auto mt-1.5 max-w-md text-[12px] text-fg-subtle">
        These are your own — notdownhub requires none. You can also manage them from the CLI on the
        machine that runs <code className="font-mono">ndh dispatch</code>, for example{" "}
        <code className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg">{example}</code>
      </p>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-line-muted">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="h-4 w-16 animate-pulse rounded bg-raised" />
          <div className="h-4 flex-1 animate-pulse rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}
