import type { Command } from "commander";
import { connErrorCode, hubUnreachableMessage, log, rootErrorMessage, unwrap } from "./lib.js";
import { getFleet, getRunMeta, stateLabel, type Fleet } from "./fleet.js";
import type { RunMeta } from "./agents-info.js";

/** The project a run belongs to — `owner/repo`, or whichever half the run carries. */
export function projectLabel(run: { owner?: string; repo?: string }): string {
  const owner = run.owner?.trim();
  const repo = run.repo?.trim();
  if (owner && repo) return `${owner}/${repo}`;
  return repo || owner || "local";
}

/** Compact wall-clock duration: "820ms", "3.2s", "1m04s". */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

/** Trim the hub's "YYYY-MM-DD HH:MM:SS.ffffff" to whole seconds with a UTC marker. */
export function fmtTime(hubTime: string): string {
  const m = hubTime.match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)/);
  return m ? `${m[1]} ${m[2]}Z` : hubTime;
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

/** Seams so the display is unit-testable without a live hub or its SQLite DB. */
export interface StatusDeps {
  fleet?: (server: string) => Promise<Fleet>;
  runMeta?: (server: string) => Promise<Map<number, RunMeta>>;
}

type Run = { id: number; fileName?: string; displayName?: string; status?: string; result?: string; eventName?: string; owner?: string; repo?: string };

/** `ndh status --server <hub>` — quick text overview of runners and recent runs. */
export async function statusCmd(server: string, deps: StatusDeps = {}): Promise<number> {
  const base = server.endsWith("/") ? server : `${server}/`;
  try {
    // Runners: the rich view (labels + online/busy/idle/offline) when --server is the local hub,
    // else the proxied names-only view — same reachability as the loopback-gated UI endpoint (#68).
    const { rich, agents } = await (deps.fleet ?? ((s) => getFleet(s)))(server);
    console.log("runners:");
    if (agents.length === 0) {
      console.log("  (none registered)");
    } else {
      for (const a of agents) {
        const labels = a.labels.join(",");
        console.log(rich ? `  ${a.name}  [${labels}]  ${stateLabel(a)}` : `  ${a.name}  [${labels}]`);
      }
    }

    // Runs: enrich each line with when it started, how long it took, and which runner ran it —
    // from the co-located hub DB. Absent (a run that never ran on the fleet) → the plain line.
    const meta = await (deps.runMeta ?? ((s) => getRunMeta(s)))(server);
    const runs = unwrap<Run>(await getJson(base, "_apis/v1/Message/workflow/runs?page=0"));
    console.log("recent runs:");
    for (const r of runs.slice(0, 15)) {
      const m = meta.get(r.id);
      const extras = [
        m?.startedAt ? fmtTime(m.startedAt) : "",
        m?.durationMs !== undefined ? fmtDuration(m.durationMs) : "",
        m && m.runners.length ? `on ${m.runners.join(",")}` : "",
      ].filter(Boolean);
      const tail = extras.length ? `  ${extras.join("  ")}` : "";
      console.log(`  #${r.id}  ${r.displayName ?? r.fileName ?? "?"}  [${projectLabel(r)}]  ${r.status ?? ""}${r.result ? `/${r.result}` : ""}  (${r.eventName ?? "?"})${tail}`);
    }
    if (runs.length === 0) console.log("  (no runs yet)");
    return 0;
  } catch (err) {
    // A connection-level failure means the hub is down / --server is wrong (#69): translate the
    // raw "fetch failed" into one actionable [ndh] line + the underlying error. A non-connection
    // error (e.g. a 5xx from a live hub) still surfaces unchanged.
    if (!connErrorCode(err)) throw err;
    log(hubUnreachableMessage(server));
    log(`  ${rootErrorMessage(err)}`);
    return 1;
  }
}
