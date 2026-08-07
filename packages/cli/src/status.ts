import type { Command } from "commander";
import { unwrap } from "./lib.js";

interface Agent {
  name?: string;
  ephemeral?: boolean;
  status?: number | string;
  labels?: { name?: string }[];
  [k: string]: unknown;
}

/** The project a run belongs to — `owner/repo`, or whichever half the run carries. */
export function projectLabel(run: { owner?: string; repo?: string }): string {
  const owner = run.owner?.trim();
  const repo = run.repo?.trim();
  if (owner && repo) return `${owner}/${repo}`;
  return repo || owner || "local";
}

async function getJson<T>(base: string, path: string): Promise<T> {
  const res = await fetch(new URL(path, base));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("show runners + recent runs")
    .option("--server <url>", "hub base url", "http://localhost:4949")
    .action(async (opts: { server: string }) => {
      process.exitCode = await statusCmd(opts.server);
    });
}

/** `ndh status --server <hub>` — quick text overview of runners and recent runs. */
export async function statusCmd(server: string): Promise<number> {
  const base = server.endsWith("/") ? server : `${server}/`;

  const poolList = unwrap<{ id: number }>(await getJson(base, "_apis/v1/AgentPools"));
  console.log("runners:");
  let any = false;
  for (const pool of poolList) {
    for (const a of unwrap<Agent>(await getJson(base, `_apis/v1/Agent/${pool.id}`))) {
      any = true;
      const labels = (a.labels ?? []).map((l) => l.name).filter(Boolean).join(",");
      console.log(`  ${a.name}  [${labels}]`);
    }
  }
  if (!any) console.log("  (none registered)");

  type Run = { id: number; fileName?: string; displayName?: string; status?: string; result?: string; eventName?: string; owner?: string; repo?: string };
  const runs = unwrap<Run>(await getJson(base, "_apis/v1/Message/workflow/runs?page=0"));
  console.log("recent runs:");
  for (const r of runs.slice(0, 15)) {
    console.log(`  #${r.id}  ${r.displayName ?? r.fileName ?? "?"}  [${projectLabel(r)}]  ${r.status ?? ""}${r.result ? `/${r.result}` : ""}  (${r.eventName ?? "?"})`);
  }
  if (runs.length === 0) console.log("  (no runs yet)");
  return 0;
}
