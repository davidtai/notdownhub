import { useMemo } from "react";
import { KeyRound, Variable, Lock, Tag, TriangleAlert } from "lucide-react";
import { getConfig } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { AppBar } from "../components/AppBar";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

const GLOBAL = "global";

function scopeLabel(scope: string): string {
  return scope === GLOBAL ? "global" : scope;
}

export function Settings() {
  const cfg = usePoll(() => getConfig(), 5000);
  const data = cfg.data;
  const secrets = useMemo(() => data?.secrets ?? [], [data]);
  const vars = useMemo(() => data?.vars ?? [], [data]);

  return (
    <div className="min-h-full">
      <AppBar />

      <main className="mx-auto max-w-[1160px] px-4 py-6 sm:px-6">
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-fg">Secrets and variables</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-fg-muted">
            Values injected into workflow runs on this hub. This view is read-only — add or change
            them from the CLI. Secret values are never shown here.
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
                  <table className="w-full text-left text-[13px]">
                    <THead cols={["Scope", "Name", "Value"]} />
                    <tbody className="divide-y divide-line-muted">
                      {secrets.map((s) => (
                        <tr key={`${s.scope}/${s.name}`} className="hover:bg-raised">
                          <Td>
                            <Badge variant="outline">{scopeLabel(s.scope)}</Badge>
                          </Td>
                          <Td className="font-mono text-fg">{s.name}</Td>
                          <Td className="font-mono text-fg-subtle">
                            <span className="inline-flex items-center gap-1.5">
                              <Lock size={12} />
                              hidden
                            </span>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                  <table className="w-full text-left text-[13px]">
                    <THead cols={["Scope", "Name", "Value"]} />
                    <tbody className="divide-y divide-line-muted">
                      {vars.map((v) => (
                        <tr key={`${v.scope}/${v.name}`} className="hover:bg-raised">
                          <Td>
                            <Badge variant="outline">{scopeLabel(v.scope)}</Badge>
                          </Td>
                          <Td className="font-mono text-fg">{v.name}</Td>
                          <Td className="max-w-0 truncate font-mono text-fg-muted">{v.value}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function THead({ cols }: { cols: string[] }) {
  return (
    <thead>
      <tr className="border-b border-line">
        {cols.map((c) => (
          <th key={c} className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
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

function EmptyRow({ icon, label, example }: { icon: React.ReactNode; label: string; example: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <span className="inline-flex items-center gap-2 text-[13px] text-fg-muted">
        <span className="text-fg-subtle">{icon}</span>
        {label}
      </span>
      <p className="mx-auto mt-1.5 max-w-md text-[12px] text-fg-subtle">
        These are your own — notdownhub requires none. Manage them from the CLI on the machine
        that runs <code className="font-mono">ndh dispatch</code>. For example:
      </p>
      <div className="mt-2">
        <code className="rounded-md bg-raised px-2.5 py-1 font-mono text-[12px] text-fg">{example}</code>
      </div>
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
