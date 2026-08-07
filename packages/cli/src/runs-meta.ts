import type { ServerResponse } from "node:http";
import { readRunMeta } from "./agents-info.js";

/*
  GET /api/local/runs-meta?ids=1,2,3 — batch per-run timing for the web UI (issue #96).

  The engine's runs-list payload carries NO time field, so the UI's runs list had
  nothing to render. The timing truth lives in the hub DB's Job timeline records —
  the exact source `ndh status` reads (readRunMeta, #76) and #91's lastRun derives
  from. This endpoint serves that source to the browser in ONE DB read per request:
  the page asks for all its visible run ids at once, never one request per row.

  Response: { "<id>": { startedAt?, finishedAt?, durationMs?, runningJobs? } }
  with ISO-8601 UTC times. An id the DB has no Job records for (never picked up,
  or simply unknown) is absent from the map — the UI falls back rather than being
  fed a fabricated time. An in-progress run has startedAt but no
  finishedAt/durationMs, plus `runningJobs` (#132): the active/queued jobs of its
  current attempt, so the runs list can say WHICH job is executing right now.
*/

export interface RunMetaWire {
  /** ISO-8601 UTC. Earliest Job record start across the run's jobs. */
  startedAt?: string;
  /** ISO-8601 UTC. Latest Job record finish; absent while the run is in progress. */
  finishedAt?: string;
  /** Wall-clock startedAt→finishedAt; absent until the run finishes. */
  durationMs?: number;
  /**
   * Active/queued jobs of the run's CURRENT attempt (#132) — only while that
   * attempt is in progress; a finished run never carries the field (backward
   * compatible). `key` is the stable YAML job key #114 aliases are stored
   * under; `name` the original display name.
   */
  runningJobs?: { key: string; name: string }[];
}

/** Upper bound on ids per request — several UI pages' worth, and a flood stop. */
export const MAX_META_IDS = 500;

/**
 * Parse the `ids` query parameter: comma-separated positive integers, deduplicated.
 * Returns null when the parameter is missing, empty, non-numeric, or oversized —
 * the caller answers 400 (a malformed request, distinct from unknown ids).
 */
export function parseMetaIds(raw: string | null): number[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0 || parts.length > MAX_META_IDS) return null;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** Hub DB "YYYY-MM-DD HH:MM:SS.ffffff" (UTC) → ISO-8601, or undefined if unparseable. */
function toIso(s: string | undefined): string | undefined {
  if (!s) return undefined;
  let t = Date.parse(`${s.replace(" ", "T")}Z`);
  if (!Number.isFinite(t)) t = Date.parse(s); // already zoned — parse as-is
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/**
 * Serve the batch. One readRunMeta() call reads the whole hub DB once, whatever
 * the batch size; requested ids without records are silently absent (tolerated).
 * An unreadable DB degrades to `{}` — the UI just renders rows without times.
 */
export async function serveRunsMeta(idsParam: string | null, res: ServerResponse, hubDb?: string): Promise<void> {
  const ids = parseMetaIds(idsParam);
  if (!ids) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `ids must be 1..${MAX_META_IDS} comma-separated run ids` }));
    return;
  }
  const all = hubDb === undefined ? await readRunMeta() : await readRunMeta(hubDb);
  const out: Record<number, RunMetaWire> = {};
  for (const id of ids) {
    const m = all.get(id);
    if (!m) continue; // unknown / never ran on the fleet → absent, never fabricated
    const entry: RunMetaWire = {};
    const startedAt = toIso(m.startedAt);
    const finishedAt = toIso(m.finishedAt);
    if (startedAt) entry.startedAt = startedAt;
    if (finishedAt) entry.finishedAt = finishedAt;
    if (m.durationMs !== undefined) entry.durationMs = m.durationMs;
    if (m.runningJobs?.length) entry.runningJobs = m.runningJobs;
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
}
