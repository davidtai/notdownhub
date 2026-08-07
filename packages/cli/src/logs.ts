import type { Command } from "commander";
import http from "node:http";
import https from "node:https";
import { connErrorCode, hubUnreachableMessage, log, rootErrorMessage, unwrap } from "./lib.js";
import { createSseParser, stripAnsi, type SseEvent } from "./joblogs.js";

/**
 * `ndh logs <run-id>` and `ndh watch <run-id>` (issue #66).
 *
 * A run started by anything other than your own foreground `ndh dispatch` — a git post-receive
 * hook, an `on: schedule`, or a dispatch from another machine — had no CLI way to be followed or
 * to have its logs read. These two commands close that:
 *   - logs  : a finished run's persisted job logs (the same joblogs the UI reads from
 *             /api/local/joblogs). That endpoint is loopback-gated, so this reaches it over a
 *             loopback --server (the SSH'd operator on the hub) — no gate weakened, no front change.
 *   - watch : follows a live run's console via the SAME global SSE feed the UI subscribes to
 *             (/_apis/v1/TimeLineWebConsoleLog, proxied — works over the network like `status`),
 *             printing plain text and exiting when the run completes.
 */

interface Job {
  timeLineId: string;
  name?: string;
}
interface Attempt {
  attempt: number;
  status?: string | null;
  result?: string | null;
}

function baseOf(server: string): string {
  return server.endsWith("/") ? server : `${server}/`;
}

/* c8 ignore start — thin fetch glue; the parsing/formatting it feeds is unit-tested, the I/O is live-verified */
async function httpGetJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).pathname}: ${res.status}`), { httpStatus: res.status });
  return res.json();
}
/* c8 ignore stop */

/** The highest-numbered attempt (the one the UI shows by default). */
export function pickLatestAttempt(attempts: Attempt[]): Attempt | null {
  if (!attempts.length) return null;
  return attempts.reduce((a, b) => (b.attempt > a.attempt ? b : a));
}

export interface RunView {
  attempt: number;
  completed: boolean;
  result?: string | null;
  jobs: Job[];
}

/** Resolve a run's latest attempt + its jobs (timeline ids + names) via the proxied hub API. */
export async function resolveRun(base: string, runId: number, getJson: (u: string) => Promise<unknown>): Promise<RunView | null> {
  const attempts = unwrap<Attempt>(await getJson(new URL(`_apis/v1/Message/workflow/run/${runId}/attempts`, base).toString()));
  const latest = pickLatestAttempt(attempts);
  if (!latest) return null;
  const jobs = unwrap<Job>(
    await getJson(new URL(`_apis/v1/Message/workflow/run/${runId}/attempt/${latest.attempt}/jobs`, base).toString()),
  ).filter((j) => j.timeLineId);
  return { attempt: latest.attempt, completed: (latest.status ?? "").toLowerCase() === "completed", result: latest.result, jobs };
}

// ── ndh logs ──────────────────────────────────────────────────────────────────
export interface LogsDeps {
  getJson?: (url: string) => Promise<unknown>;
  getJoblogs?: (base: string, runId: number, timelineId: string) => Promise<{ retained: boolean; lines: string[]; status?: number }>;
}

/* c8 ignore start — fetch glue for the loopback-gated joblogs endpoint; exercised by the live verify */
async function httpGetJoblogs(base: string, runId: number, timelineId: string): Promise<{ retained: boolean; lines: string[]; status?: number }> {
  const res = await fetch(new URL(`api/local/joblogs/${runId}/${timelineId}`, base).toString());
  if (!res.ok) return { retained: false, lines: [], status: res.status };
  const body = (await res.json()) as { retained?: boolean; lines?: unknown };
  return { retained: !!body.retained, lines: Array.isArray(body.lines) ? (body.lines as string[]) : [] };
}
/* c8 ignore stop */

/** Render a run's job logs to stdout lines. Pure so the formatting is unit-testable.
 * `denied` is the HTTP status the gated joblogs endpoint answered with: 403 when the hub is
 * loopback-only, 401 when it runs with --basic-auth (#100). Either way the logs exist — never
 * report an auth denial as "no retained logs". */
export function formatRunLogs(
  runId: number,
  jobs: { name?: string; retained: boolean; lines: string[]; denied?: number }[],
): string[] {
  const out: string[] = [];
  const many = jobs.length > 1;
  let anyRetained = false;
  for (const j of jobs) {
    if (many) out.push(`=== ${j.name ?? "job"} ===`);
    if (j.denied) {
      out.push(
        j.denied === 401
          ? `[ndh] run #${runId}: this hub requires basic auth for logs — run on the hub host, tunnel the port, or open the UI with credentials`
          : `[ndh] run #${runId} logs are loopback-gated on the hub — run this on the hub host, or tunnel the hub port`,
      );
      continue;
    }
    if (j.retained && j.lines.length) {
      anyRetained = true;
      out.push(...j.lines);
    } else {
      out.push(`[ndh] no retained logs for ${many ? `job '${j.name ?? "?"}'` : `run #${runId}`} (predates retention, or it never ran on the fleet)`);
    }
  }
  if (!jobs.length) out.push(`[ndh] run #${runId} has no jobs (unknown run id?)`);
  void anyRetained;
  return out;
}

/** `ndh logs <run-id> --server <hub>` — print a completed run's persisted job logs. */
export async function logsCmd(runId: number, server: string, deps: LogsDeps = {}): Promise<number> {
  const base = baseOf(server);
  const getJson = deps.getJson ?? httpGetJson;
  const getJoblogs = deps.getJoblogs ?? httpGetJoblogs;
  try {
    const run = await resolveRun(base, runId, getJson);
    if (!run || run.jobs.length === 0) {
      for (const line of formatRunLogs(runId, [])) console.log(line);
      return run ? 0 : 1;
    }
    const jobs = await Promise.all(
      run.jobs.map(async (j) => {
        const r = await getJoblogs(base, runId, j.timeLineId);
        // 403 = loopback-only hub; 401 = --basic-auth hub (#100). Both are an auth gate, not
        // missing logs — carry the status through so the message names the actual gate.
        const denied = r.status === 401 || r.status === 403 ? r.status : undefined;
        return { name: j.name, retained: r.retained, lines: r.lines, denied };
      }),
    );
    for (const line of formatRunLogs(runId, jobs)) console.log(line);
    return jobs.some((j) => j.denied) ? 1 : 0;
  } catch (err) {
    if (!connErrorCode(err)) throw err;
    log(hubUnreachableMessage(server));
    log(`  ${rootErrorMessage(err)}`);
    return 1;
  }
}

// ── ndh watch ───────────────────────────────────────────────────────────────
/** Lines to print for one SSE frame, if it belongs to a timeline we're following. Pure/testable. */
export function frameLines(ev: SseEvent, timelines: Set<string>): string[] {
  if (ev.event !== "log") return [];
  try {
    const d = JSON.parse(ev.data) as { timelineId?: string; record?: { value?: string[] } };
    if (!d.timelineId || !timelines.has(d.timelineId) || !d.record?.value?.length) return [];
    return d.record.value.map((l) => stripAnsi(l));
  } catch {
    return [];
  }
}

export interface WatchDeps {
  getJson?: (url: string) => Promise<unknown>;
  /** Open the hub's global console SSE feed; call onChunk per raw chunk; return a close fn. */
  openConsole?: (base: string, onChunk: (s: string) => void, onError: (e: unknown) => void) => () => void;
  delay?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Emit a printable line (defaults to stdout). */
  emit?: (line: string) => void;
}

/* c8 ignore start — real SSE socket; the frame handling it feeds is unit-tested, the stream is live-verified */
function openConsoleHttp(base: string, onChunk: (s: string) => void, onError: (e: unknown) => void): () => void {
  const url = new URL("_apis/v1/TimeLineWebConsoleLog", base);
  const mod = url.protocol === "https:" ? https : http;
  const req = mod.get(url, (r) => {
    r.setEncoding("utf8");
    r.on("data", onChunk);
    r.on("end", () => onError(new Error("console stream ended")));
    r.on("error", onError);
  });
  req.on("error", onError);
  return () => req.destroy();
}
/* c8 ignore stop */

/**
 * `ndh watch <run-id>` — follow a live run's console. Subscribes to the hub's global console SSE
 * feed and prints the lines whose timeline belongs to this run, refreshing the run's job set as
 * matrix legs appear, until the run completes (then drains briefly and exits 0).
 */
export async function watchCmd(runId: number, server: string, deps: WatchDeps = {}): Promise<number> {
  const base = baseOf(server);
  const getJson = deps.getJson ?? httpGetJson;
  const openConsole = deps.openConsole ?? openConsoleHttp;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 2000;
  const emit = deps.emit ?? ((l: string) => console.log(l));

  let initial: RunView | null;
  try {
    initial = await resolveRun(base, runId, getJson);
  } catch (err) {
    if (!connErrorCode(err)) throw err;
    log(hubUnreachableMessage(server));
    log(`  ${rootErrorMessage(err)}`);
    return 1;
  }
  if (!initial) {
    log(`run #${runId} not found`);
    return 1;
  }
  if (initial.completed) {
    log(`run #${runId} already completed (${initial.result ?? "?"}) — use 'ndh logs ${runId}' for its output`);
    return 0;
  }

  const timelines = new Set<string>(initial.jobs.map((j) => j.timeLineId));
  let closed = false;
  let sawError: unknown = null;
  const parse = createSseParser((ev) => {
    for (const line of frameLines(ev, timelines)) emit(line);
  });
  const close = openConsole(base, parse, (e) => {
    sawError = e;
  });

  try {
    // Poll for new job timelines (matrix legs) + run completion; the SSE feed does the streaming.
    for (;;) {
      await delay(pollMs);
      let view: RunView | null = null;
      try {
        view = await resolveRun(base, runId, getJson);
      } catch (err) {
        // A transient poll failure shouldn't kill the follow; a hard connection failure ends it.
        if (connErrorCode(err)) {
          sawError = err;
          break;
        }
      }
      if (view) {
        for (const j of view.jobs) timelines.add(j.timeLineId);
        if (view.completed) {
          await delay(Math.min(pollMs, 800)); // let the last console frames arrive
          log(`run #${runId} completed (${view.result ?? "?"})`);
          return 0;
        }
      }
      if (closed || sawError) break;
    }
  } finally {
    close();
  }
  if (sawError && connErrorCode(sawError)) {
    log(hubUnreachableMessage(server));
    log(`  ${rootErrorMessage(sawError)}`);
    return 1;
  }
  return 1;
}

export function registerLogs(program: Command): void {
  program
    .command("logs")
    .description("print a completed run's persisted job logs")
    .argument("<run-id>", "run id (see `ndh status`)")
    .option("--server <url>", "hub base url", "http://localhost:4949")
    .action(async (runId: string, opts: { server: string }) => {
      process.exitCode = await logsCmd(Number(runId), opts.server);
    });

  program
    .command("watch")
    .description("follow a running run's console live (exits when the run completes)")
    .argument("<run-id>", "run id (see `ndh status`)")
    .option("--server <url>", "hub base url", "http://localhost:4949")
    .action(async (runId: string, opts: { server: string }) => {
      process.exitCode = await watchCmd(Number(runId), opts.server);
    });
}
