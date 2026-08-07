import type { ServerResponse } from "node:http";
import { deleteRun, joblogsDbPath, readDeletedRunIds } from "./joblogs.js";
import { dropTree } from "./treecache.js";
import { unwrap } from "./lib.js";
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
}
function splitEnvelope(data: unknown): { runs: RunLike[]; wrapped: boolean } {
  if (Array.isArray(data)) return { runs: data as RunLike[], wrapped: false };
  const value = (data as { value?: RunLike[] } | null)?.value;
  return { runs: Array.isArray(value) ? value : [], wrapped: true };
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
  json(res, 200, wrapped ? { count: kept.length, value: kept } : kept);
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
export const __test = { splitEnvelope, fetchProjectRuns };
