import { useParams } from "react-router-dom";
import { getWorkflowDefinition } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { AppBar } from "../components/AppBar";
import { Card } from "../components/ui/card";

/**
 * Read-only preview of the workflow YAML the hub retained for a run. Reached in a
 * NEW TAB from the Projects page (a plain link, so it deep-links and can be shared).
 * One-shot fetch — a stored definition doesn't change under us.
 */
export function WorkflowPreview() {
  const { runId } = useParams<{ runId: string }>();
  const id = Number(runId);
  const def = usePoll(() => getWorkflowDefinition(id), 0, [id]);

  return (
    <div className="min-h-full">
      <AppBar />
      <main className="mx-auto max-w-[1160px] px-4 py-6 sm:px-6">
        <div className="mb-4">
          <h1 className="text-lg font-semibold text-fg">Workflow definition</h1>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            The exact YAML the hub recorded for run{" "}
            <span className="tnum font-mono">#{Number.isFinite(id) ? id : "?"}</span>.
          </p>
        </div>

        <Card className="overflow-hidden">
          {def.initial ? (
            <div className="p-4">
              <div className="h-64 w-full animate-pulse rounded bg-raised" />
            </div>
          ) : def.data?.yaml ? (
            <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-relaxed text-fg">
              <code>{def.data.yaml}</code>
            </pre>
          ) : (
            <div className="px-6 py-16 text-center text-sm text-fg-muted">
              No workflow definition was retained for this run.
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}
