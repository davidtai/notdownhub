import type { ServerResponse } from "node:http";
import type { Command } from "commander";
import { unwrap } from "./lib.js";
import { projectLabel } from "./status.js";
import { joblogsDbPath, readDeletedRunIds } from "./joblogs.js";

/*
  The Projects surface, derived from the hub's FULL run history (issue #90).

  There is no project registry by design — any checkout can dispatch — so "which
  projects does this hub serve?" is answered from every run the hub has recorded.
  Deriving it from one 30-run page (the engine pages `?page=N` at 30) silently
  drops any project whose runs happen to sit on later pages, so all derivation
  here starts from the UNPAGED runs list: the engine returns the complete history
  when the `page` parameter is omitted (verified against the vendored
  Runner.Server — `page.HasValue ? query.Skip(page*30).Take(30) : query`).

  One aggregation (`aggregateProjects`) feeds every consumer:
    - GET /api/local/projects  (front.ts) — the web Projects page, computed
      server-side so the browser never has to page the whole history;
    - `ndh projects --server`  — the same rows, printed.

  local / unattributed runs are never merged into one fake project: each recorded
  label stays its own row, and rows are classified (`kind`) so callers can say
  honestly what the row is — a real repo, a `local/<dir>` checkout slug (#59's
  fallback, grouped only by directory name), or unattributed runs
  (`Unknown/Unknown`, the engine's value when a run carried no usable
  `github.repository` at all).
*/

export interface Run {
  id: number;
  fileName?: string;
  displayName?: string;
  status?: string;
  result?: string;
  eventName?: string;
  owner?: string;
  repo?: string;
}

/** How honestly to present a derived project row. */
export type ProjectKind = "repo" | "local" | "unattributed";

export interface ProjectWorkflowSummary {
  /** Stable identity of the workflow across runs — its file, else its display name. */
  key: string;
  /** Bare file name (path stripped), for display and the YAML preview link. */
  fileName: string;
  /** Human label (display name when present). */
  label: string;
  runCount: number;
  /** The most recent run of this workflow (max id — run ids are monotonic). */
  latestRun: Run;
  latestRunId: number;
}

export interface ProjectSummary {
  /** The exact recorded label (projectLabel) — never a merged or invented name. */
  name: string;
  kind: ProjectKind;
  runCount: number;
  /** The project's most recent run overall (max id). */
  lastRun: Run;
  lastRunId: number;
  workflows: ProjectWorkflowSummary[];
}

/**
 * Classify a run's attribution. `local` is #59's `local/<dir>` fallback slug for
 * checkouts without an origin remote — a real recorded label, but grouped only by
 * directory name. `unattributed` covers runs with no usable attribution at all:
 * the engine's `Unknown/Unknown`, or a missing owner/repo half (pre-#59 data).
 */
export function projectKind(run: { owner?: string | null; repo?: string | null }): ProjectKind {
  const owner = run.owner?.trim();
  const repo = run.repo?.trim();
  if (!owner || !repo || owner === "Unknown" || repo === "Unknown") return "unattributed";
  if (owner === "local") return "local";
  return "repo";
}

function workflowKey(r: Run): string {
  return r.fileName || r.displayName || `run-${r.id}`;
}
function workflowLabel(r: Run): string {
  return r.displayName || r.fileName || `Run ${r.id}`;
}
function workflowFileName(r: Run): string {
  const f = r.fileName;
  if (f) return f.split("/").pop() || f;
  return r.displayName || `run-${r.id}`;
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(value);
}

const latestById = (runs: Run[]): Run => runs.reduce((a, b) => (b.id > a.id ? b : a));

const KIND_ORDER: Record<ProjectKind, number> = { repo: 0, local: 1, unattributed: 2 };

/**
 * Group runs (the FULL history) into the distinct-projects list: one row per
 * recorded label, with exact run counts, the most-recent run, the per-workflow
 * breakdown, and the honesty classification. Sorted real repos first, then local
 * checkout slugs, then unattributed — alphabetical within each group.
 */
export function aggregateProjects(runs: Run[]): ProjectSummary[] {
  const byProject = new Map<string, Run[]>();
  for (const r of runs) pushInto(byProject, projectLabel(r), r);

  const projects: ProjectSummary[] = [];
  for (const [name, projectRuns] of byProject) {
    const byWorkflow = new Map<string, Run[]>();
    for (const r of projectRuns) pushInto(byWorkflow, workflowKey(r), r);

    const workflows: ProjectWorkflowSummary[] = [...byWorkflow.entries()].map(([key, wfRuns]) => {
      const latestRun = latestById(wfRuns);
      return {
        key,
        fileName: workflowFileName(latestRun),
        label: workflowLabel(latestRun),
        runCount: wfRuns.length,
        latestRun,
        latestRunId: latestRun.id,
      };
    });
    workflows.sort((a, b) => a.label.localeCompare(b.label));

    const lastRun = latestById(projectRuns);
    projects.push({
      name,
      kind: projectKind(lastRun),
      runCount: projectRuns.length,
      lastRun,
      lastRunId: lastRun.id,
      workflows,
    });
  }
  projects.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
  return projects;
}

/**
 * GET /api/local/projects — the distinct-projects list across the FULL run
 * history, computed hub-side. One unpaged engine query (complete by
 * construction — no page cap to fall off), tombstoned (deleted) runs excluded
 * with the same store serveFilteredRuns enforces, then aggregated. Gated by the
 * caller (front.ts) like every other /api/local read.
 */
export async function serveProjects(hubPort: number, res: ServerResponse, dbPath = joblogsDbPath()): Promise<void> {
  let runs: Run[];
  try {
    // No `page` param: the engine returns the complete run history in one response.
    const up = await fetch(`http://127.0.0.1:${hubPort}/_apis/v1/Message/workflow/runs`);
    if (!up.ok) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `engine returned ${up.status}` }));
      return;
    }
    runs = unwrap<Run>(await up.json());
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `hub unavailable: ${err}` }));
    return;
  }
  const deleted = await readDeletedRunIds(dbPath);
  const kept = runs.filter((r) => typeof r.id !== "number" || !deleted.has(r.id));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(aggregateProjects(kept)));
}

async function getJson<T>(base: string, path: string): Promise<T> {
  const res = await fetch(new URL(path, base));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export function registerProjects(program: Command): void {
  program
    .command("projects")
    .description("list the projects this hub has run (derived from the full run history)")
    .option("--server <url>", "hub base url", "http://localhost:4949")
    .action(async (opts: { server: string }) => {
      process.exitCode = await projectsCmd(opts.server);
    });
}

/** The honesty tag printed after a non-repo row. */
function kindTag(kind: ProjectKind): string {
  if (kind === "local") return "  [local checkout]";
  if (kind === "unattributed") return "  [unattributed]";
  return "";
}

/**
 * `ndh projects --server <hub>` — the derived project list: name, run count, last
 * run + result. Reads the UNPAGED runs list (the full history — the same source
 * the hub's own /api/local/projects aggregates), so no project is ever missing
 * because its runs sat on a later page.
 */
export async function projectsCmd(server: string): Promise<number> {
  const base = server.endsWith("/") ? server : `${server}/`;
  const runs = unwrap<Run>(await getJson(base, "_apis/v1/Message/workflow/runs"));
  const rows = aggregateProjects(runs);

  console.log("projects:");
  if (rows.length === 0) {
    console.log("  (none yet)");
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const row of rows) {
    const r = row.lastRun;
    const wf = r.displayName ?? r.fileName ?? "?";
    const result = r.result ? `${r.status ?? ""}/${r.result}` : (r.status ?? "");
    const runsWord = row.runCount === 1 ? "run " : "runs";
    console.log(
      `  ${row.name.padEnd(width)}  ${String(row.runCount).padStart(3)} ${runsWord}  last: #${r.id} ${wf} ${result} (${r.eventName ?? "?"})${kindTag(row.kind)}`,
    );
  }
  return 0;
}
