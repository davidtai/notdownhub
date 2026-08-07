import type { Command } from "commander";
import { unwrap } from "./lib.js";
import { projectLabel } from "./status.js";

interface Run {
  id: number;
  fileName?: string;
  displayName?: string;
  status?: string;
  result?: string;
  eventName?: string;
  owner?: string;
  repo?: string;
}

interface ProjectRow {
  name: string;
  runCount: number;
  lastRun: Run;
}

async function getJson<T>(base: string, path: string): Promise<T> {
  const res = await fetch(new URL(path, base));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Group runs into the derived project list — name, run count, most-recent run (max id). */
export function deriveProjectRows(runs: Run[]): ProjectRow[] {
  const byProject = new Map<string, Run[]>();
  for (const r of runs) {
    const name = projectLabel(r);
    let arr = byProject.get(name);
    if (!arr) {
      arr = [];
      byProject.set(name, arr);
    }
    arr.push(r);
  }
  const rows: ProjectRow[] = [];
  for (const [name, projectRuns] of byProject) {
    const lastRun = projectRuns.reduce((a, b) => (b.id > a.id ? b : a));
    rows.push({ name, runCount: projectRuns.length, lastRun });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function registerProjects(program: Command): void {
  program
    .command("projects")
    .description("list the projects this hub has run (derived from run history)")
    .option("--server <url>", "hub base url", "http://localhost:4949")
    .action(async (opts: { server: string }) => {
      process.exitCode = await projectsCmd(opts.server);
    });
}

/** `ndh projects --server <hub>` — the derived project list: name, run count, last run + result. */
export async function projectsCmd(server: string): Promise<number> {
  const base = server.endsWith("/") ? server : `${server}/`;
  const runs = unwrap<Run>(await getJson(base, "_apis/v1/Message/workflow/runs?page=0"));
  const rows = deriveProjectRows(runs);

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
      `  ${row.name.padEnd(width)}  ${String(row.runCount).padStart(3)} ${runsWord}  last: #${r.id} ${wf} ${result} (${r.eventName ?? "?"})`,
    );
  }
  return 0;
}
