import type { ServerResponse } from "node:http";
import { deleteRun, joblogsDbPath, readDeletedRunIds } from "./joblogs.js";
import { dropTree } from "./treecache.js";
import { existsSync } from "node:fs";
import { hubDbPath, log, unwrap } from "./lib.js";
import { projectLabel } from "./status.js";

/**
 * Run control at the hub's front boundary: cancel (through the engine's own cancellation
 * endpoint) and true delete (tombstone + log purge in the DB we own). Both are surfaced as
 * gated /api/local routes by front.ts; the read paths (runs list / run detail) are filtered
 * here so a deleted run disappears everywhere.
 *
 * Why the front, and not the engine, owns deletion: Runner.Server (the vendored fork) exposes
 * cancelWorkflow/forceCancelWorkflow but NO workflow-run deletion endpoint, and its runs list is
 * served straight from its persistent WorkflowRun tables with no "deleted" flag. So a delete that
 * doesn't take effect at a durable layer reappears on the next 2.5s poll (and certainly after a
 * restart). We record the deletion in joblogs.db (persisted, ours) and enforce it at the proxy.
 */

const JSON_HEADERS = { "content-type": "application/json" } as const;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Unwrap a hub runs response that may be a bare array or an OData `{ value: [...] }` envelope. */
interface RunLike {
  id?: number;
  result?: string;
}
function splitEnvelope(data: unknown): { runs: RunLike[]; wrapped: boolean } {
  if (Array.isArray(data)) return { runs: data as RunLike[], wrapped: false };
  const value = (data as { value?: RunLike[] } | null)?.value;
  return { runs: Array.isArray(value) ? value : [], wrapped: true };
}

/*
 * Canceled-vs-failed correction (issue #156).
 *
 * The vendored engine (Runner.Server) records the JOB-level result of a canceled
 * run correctly as `canceled`, but rolls the ATTEMPT/run result up to `failed` —
 * so a run the operator cancelled is indistinguishable from a genuine failure in
 * the runs list and the run-detail header. We can't touch the engine, so the
 * front corrects the roll-up on the read path, from the job results the engine
 * itself persisted in hub.db (the same DB `ndh status` / runs-meta read).
 */

/** Result-word forms the engine uses for a genuinely failed run — the only ones we ever rewrite. */
const FAILED_RESULTS = new Set(["failed", "failure"]);

/** hub.db Job/Attempt `Result` enum (runner.server): the codes the roll-up cares about. */
function jobResultString(code: number | null): string {
  switch (code) {
    case 2:
      return "failed";
    case 3:
      return "canceled";
    default:
      return ""; // succeeded / skipped / still-pending → irrelevant to the correction
  }
}

/**
 * GitHub's roll-up of an attempt's job results, limited to the distinction the
 * engine gets wrong (#156): a genuine job failure still dominates a cancellation,
 * so a run is only "canceled" when NO job failed and at least one was canceled.
 * Returns "canceled" in exactly that case, else null (the engine's result stands).
 */
export function rollUpResult(jobResults: string[]): "canceled" | null {
  const norm = jobResults.map((r) => (r ?? "").toLowerCase());
  if (norm.some((r) => FAILED_RESULTS.has(r))) return null;
  if (norm.some((r) => r === "canceled" || r === "cancelled")) return "canceled";
  return null;
}

/** The canceled-run correction, read from hub.db in one pass; empty when the DB is unavailable. */
export interface RunResultRollup {
  /** WorkflowRunAttempt.Id → the corrected result ("canceled") for attempts the engine mislabeled. */
  byAttemptId: Map<number, "canceled">;
  /** Run id → the WorkflowRunAttempt.Id of its NEWEST attempt (the one the runs list reflects). */
  latestAttemptId: Map<number, number>;
}

/**
 * Read the per-attempt canceled correction from hub.db: for every attempt, roll
 * up its jobs' results and record the ones that should read "canceled". Scoped
 * per attempt (keyed by the attempt row Id the attempts API also exposes as
 * `id`), so a re-run only ever corrects the attempt the job belongs to. Tolerant:
 * an unreadable/absent DB (not co-located, old schema) yields no corrections.
 */
export async function readRunResultRollup(hubDb: string = hubDbPath()): Promise<RunResultRollup> {
  const byAttemptId = new Map<number, "canceled">();
  const latestAttemptId = new Map<number, number>();
  // No hub.db is a normal, expected state: `ndh run` in local mode (and any moment before the
  // hub's first run) has no hub DB, so there is simply nothing to correct. Return quietly.
  if (!existsSync(hubDb)) return { byAttemptId, latestAttemptId };
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(hubDb, { readOnly: true });
    try {
      const attempts = db
        .prepare(`SELECT Id AS id, WorkflowRunId AS runId, Attempt AS attempt FROM WorkflowRunAttempt`)
        .all() as unknown as { id: number; runId: number | null; attempt: number }[];
      const latest = new Map<number, { id: number; attempt: number }>();
      for (const a of attempts) {
        if (a.runId == null) continue;
        const cur = latest.get(a.runId);
        if (!cur || a.attempt > cur.attempt) latest.set(a.runId, { id: a.id, attempt: a.attempt });
      }
      for (const [runId, a] of latest) latestAttemptId.set(runId, a.id);

      const jobs = db
        .prepare(`SELECT WorkflowRunAttemptId AS attemptId, Result AS result FROM Jobs`)
        .all() as unknown as { attemptId: number | null; result: number | null }[];
      const byAttempt = new Map<number, string[]>();
      for (const j of jobs) {
        if (j.attemptId == null) continue;
        const list = byAttempt.get(j.attemptId) ?? byAttempt.set(j.attemptId, []).get(j.attemptId)!;
        list.push(jobResultString(j.result));
      }
      for (const [attemptId, results] of byAttempt) {
        if (rollUpResult(results) === "canceled") byAttemptId.set(attemptId, "canceled");
      }
    } finally {
      db.close();
    }
  } catch (err) {
    // The hub.db exists but we could not read or roll it up (locked, unexpected schema, corrupt).
    // That is NOT expected — degrade to the engine's own results so the read still works, but say
    // so loudly rather than hiding it, so a genuinely broken hub DB is diagnosable.
    log(`warning: could not read canceled-run corrections from ${hubDb}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { byAttemptId, latestAttemptId };
}

/** True when a run the engine marked failure-like was actually its NEWEST attempt being canceled. */
function isMislabeledCancel(result: string | undefined, runId: number | undefined, rollup: RunResultRollup): boolean {
  if (!result || !FAILED_RESULTS.has(result.toLowerCase()) || runId === undefined) return false;
  const attemptId = rollup.latestAttemptId.get(runId);
  return attemptId !== undefined && rollup.byAttemptId.get(attemptId) === "canceled";
}

/**
 * POST /api/local/runs/:id/cancel — cancel a running run via the engine's standard endpoint.
 * `force` uses forceCancelWorkflow (the recovery path for a run whose job won't wind down, e.g.
 * an abandoned `ndh dispatch` that orphaned the runner). Returns the engine's status verbatim so
 * a no-op (run already gone from the engine's in-memory workflow state) is visible as a 4xx.
 */
export async function serveRunCancel(
  hubPort: number,
  runId: number,
  force: boolean,
  res: ServerResponse,
): Promise<void> {
  const route = force ? "forceCancelWorkflow" : "cancelWorkflow";
  try {
    const up = await fetch(`http://127.0.0.1:${hubPort}/_apis/v1/Message/${route}/${runId}`, { method: "POST" });
    if (!up.ok) {
      json(res, 502, { ok: false, error: `engine returned ${up.status}`, runId });
      return;
    }
    json(res, 200, { ok: true, runId, forced: force });
  } catch (err) {
    json(res, 502, { ok: false, error: String(err), runId });
  }
}

/**
 * DELETE /api/local/runs/:id — true delete: purge the run's persisted logs and tombstone it so
 * it is gone from the runs list and its detail 404s, permanently and across restarts. Idempotent.
 */
export async function serveRunDelete(
  runId: number,
  res: ServerResponse,
  dbPath = joblogsDbPath(),
  hubDbPath?: string,
): Promise<void> {
  try {
    const { logsPurged } = await deleteRun(dbPath, runId, { hubDbPath });
    await dropTree(runId); // the retained dispatch tree (#110) goes with the run
    json(res, 200, { ok: true, runId, logsPurged });
  } catch (err) {
    json(res, 500, { ok: false, error: String(err), runId });
  }
}

/**
 * GET /_apis/v1/Message/workflow/runs — proxied through with tombstoned runs removed, preserving
 * the engine's envelope shape (bare array here, but tolerant of the OData wrapper). Every reader
 * (UI and `ndh status`) goes through this, so a deleted run never shows up for anyone.
 */
export async function serveFilteredRuns(
  hubPort: number,
  search: string,
  res: ServerResponse,
  dbPath = joblogsDbPath(),
  hubDb: string = hubDbPath(),
): Promise<void> {
  let up: Response;
  try {
    up = await fetch(`http://127.0.0.1:${hubPort}/_apis/v1/Message/workflow/runs${search}`);
  } catch (err) {
    json(res, 502, { error: `hub unavailable: ${err}` });
    return;
  }
  if (!up.ok) {
    json(res, up.status, { error: `engine returned ${up.status}` });
    return;
  }
  const data = await up.json().catch(() => []);
  const deleted = await readDeletedRunIds(dbPath);
  const { runs, wrapped } = splitEnvelope(data);
  const kept = runs.filter((r) => r.id === undefined || !deleted.has(r.id));
  // #156: a canceled run the engine mislabeled `failed` reads `canceled` again. readRunResultRollup
  // returns an empty roll-up (no corrections) when there is no hub.db or it cannot be read, so this
  // never changes the endpoint's status — but a real read failure is logged, not silently ignored.
  const rollup = await readRunResultRollup(hubDb);
  for (const r of kept) if (isMislabeledCancel(r.result, r.id, rollup)) r.result = "canceled";
  json(res, 200, wrapped ? { count: kept.length, value: kept } : kept);
}

/**
 * GET /_apis/v1/Message/workflow/run/:id/attempts — proxied through with the #156
 * canceled correction applied per attempt, so a deep-linked run (whose summary is
 * not on the runs list's first page) still shows "Canceled" in its detail header.
 * Deleted runs are handled upstream (front.ts 404s them before reaching here).
 */
export async function serveRunAttempts(
  hubPort: number,
  runId: number,
  res: ServerResponse,
  hubDb: string = hubDbPath(),
): Promise<void> {
  let up: Response;
  try {
    up = await fetch(`http://127.0.0.1:${hubPort}/_apis/v1/Message/workflow/run/${runId}/attempts`);
  } catch (err) {
    json(res, 502, { error: `hub unavailable: ${err}` });
    return;
  }
  if (!up.ok) {
    json(res, up.status, { error: `engine returned ${up.status}` });
    return;
  }
  const data = await up.json().catch(() => []);
  const { runs: attempts, wrapped } = splitEnvelope(data);
  // #156 correction: an empty roll-up (no/unreadable hub.db) leaves the engine's attempts
  // unchanged, so a hub.db problem never turns a run-detail request into a 4xx/5xx.
  const rollup = await readRunResultRollup(hubDb);
  for (const a of attempts as { id?: number; result?: string }[]) {
    if (a.result && FAILED_RESULTS.has(a.result.toLowerCase()) && a.id !== undefined && rollup.byAttemptId.get(a.id) === "canceled") {
      a.result = "canceled";
    }
  }
  json(res, 200, wrapped ? { count: attempts.length, value: attempts } : attempts);
}

/**
 * DELETE /api/local/runs?project=<owner/repo> — bulk true-delete every run of a project. This is
 * the contract the #55 Projects page ("Remove") and `ndh run delete --project` both call: one
 * server-side loop over the same single-run delete, so there is no bespoke state. Idempotent;
 * reports how many runs were deleted.
 */
export async function serveProjectDelete(
  hubPort: number,
  project: string | null,
  res: ServerResponse,
  dbPath = joblogsDbPath(),
): Promise<void> {
  if (!project) {
    json(res, 400, { ok: false, error: "missing ?project=<owner/repo>" });
    return;
  }
  let runs: { id?: number; owner?: string; repo?: string }[];
  try {
    runs = await fetchProjectRuns(hubPort, project);
  } catch (err) {
    json(res, 502, { ok: false, error: `hub unavailable: ${err}`, project });
    return;
  }
  const ids = runs.map((r) => r.id).filter((id): id is number => typeof id === "number");
  let deleted = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await deleteRun(dbPath, id);
      await dropTree(id);
      deleted++;
    } catch {
      failed++;
    }
  }
  json(res, failed ? 207 : 200, { ok: failed === 0, project, deleted, failed, runIds: ids });
}

/** Every run belonging to `project`, paged out of the hub's runs list (matched on projectLabel). */
async function fetchProjectRuns(
  hubPort: number,
  project: string,
): Promise<{ id?: number; owner?: string; repo?: string }[]> {
  const out: { id?: number; owner?: string; repo?: string }[] = [];
  for (let page = 0; page < 1000; page++) {
    const up = await fetch(`http://127.0.0.1:${hubPort}/_apis/v1/Message/workflow/runs?page=${page}`);
    if (!up.ok) throw new Error(`engine returned ${up.status}`);
    const rows = unwrap<{ id?: number; owner?: string; repo?: string }>(await up.json());
    if (rows.length === 0) break;
    for (const r of rows) if (projectLabel(r) === project) out.push(r);
    if (rows.length < 30) break; // last page (engine pages at 30)
  }
  return out;
}

/** Exposed for tests. */
export const __test = { splitEnvelope, fetchProjectRuns, jobResultString, isMislabeledCancel };
