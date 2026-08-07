import { hubDbPath, unwrap } from "./lib.js";

/**
 * Runner status for the UI's Runners page. The hub's Agent read API exposes neither
 * labels nor a live "busy" signal, so we enrich it from the hub's SQLite database
 * (read-only) and the session-based liveness probe:
 *   - labels           ← AgentLabel table
 *   - busy (a job now)  ← an in-progress "Job" timeline record assigned to the runner
 *   - online            ← GET /_apis/v1/Message/isagentonline
 * State = online + busy → active; online → idle; otherwise offline.
 *
 * Everything degrades: if the database cannot be read, agents come from the hub API
 * without labels or busy state, and the UI simply hides the label chips.
 */

export interface AgentInfo {
  id?: number;
  /** Agent pool the runner belongs to. Needed with `id` to unregister it: DELETE /_apis/v1/Agent/{poolId}/{id}. */
  poolId?: number;
  name: string;
  version?: string;
  os?: string;
  ephemeral: boolean;
  maxParallelism?: number;
  labels: string[];
  online: boolean;
  busy: boolean;
  state: "active" | "idle" | "offline";
}

interface BaseAgent {
  id?: number;
  poolId?: number;
  name: string;
  version?: string;
  os?: string;
  ephemeral?: number;
  maxParallelism?: number;
}

interface DbRead {
  agents: BaseAgent[];
  labels: Map<number, string[]>;
  busy: Set<string>;
}

/** Read agents, their labels, and the set of runners with an in-progress job. */
async function readFromDb(): Promise<DbRead | null> {
  try {
    // node:sqlite is still experimental; import lazily so its absence degrades cleanly.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(hubDbPath(), { readOnly: true });
    try {
      const agents = db
        .prepare(
          `SELECT t.Id AS id, a.PoolId AS poolId, t.Name AS name, t.Version AS version, t.OSDescription AS os,
                  t.Ephemeral AS ephemeral, t.MaxParallelism AS maxParallelism
           FROM Agents a JOIN TaskAgentReference t ON a.TaskAgentId = t.Id`,
        )
        .all() as unknown as BaseAgent[];
      const labelRows = db.prepare(`SELECT TaskAgentId AS id, Name AS name FROM AgentLabel`).all() as unknown as {
        id: number;
        name: string;
      }[];
      // State 1 = InProgress; RecordType 'Job' records carry the runner in WorkerName.
      const busyRows = db
        .prepare(`SELECT DISTINCT WorkerName AS name FROM TimeLineRecords WHERE RecordType = 'Job' AND State = 1`)
        .all() as unknown as { name: string | null }[];

      const labels = new Map<number, string[]>();
      for (const r of labelRows) {
        if (!r.name) continue;
        const arr = labels.get(r.id) ?? [];
        // System (Type 0) and user (Type 1) labels overlap — dedupe case-insensitively.
        if (!arr.some((x) => x.toLowerCase() === r.name.toLowerCase())) arr.push(r.name);
        labels.set(r.id, arr);
      }
      const busy = new Set<string>(busyRows.map((r) => r.name).filter((n): n is string => !!n));
      return { agents, labels, busy };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function isOnline(hubPort: number, name: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${hubPort}/_apis/v1/Message/isagentonline?name=${encodeURIComponent(name)}`);
    if (!res.ok) return false;
    const body = (await res.json()) as { online?: boolean };
    return !!body.online;
  } catch {
    return false;
  }
}

/** Fallback agent list from the hub API (used only when the database can't be read). */
async function agentsFromApi(hubPort: number, mint: () => Promise<string | null>): Promise<BaseAgent[]> {
  try {
    const bearer = await mint();
    const headers: Record<string, string> = bearer ? { authorization: `Bearer ${bearer}` } : {};
    const pools = unwrap<{ id: number }>(
      await fetch(`http://127.0.0.1:${hubPort}/_apis/v1/AgentPools`, { headers }).then((r) => r.json()),
    );
    const out: BaseAgent[] = [];
    for (const p of pools) {
      const agents = unwrap<Record<string, unknown>>(
        await fetch(`http://127.0.0.1:${hubPort}/_apis/v1/Agent/${p.id}`, { headers }).then((r) => r.json()),
      );
      for (const a of agents as Record<string, unknown>[]) {
        out.push({
          id: a.id as number,
          poolId: p.id,
          name: a.name as string,
          version: a.version as string,
          os: a.osDescription as string,
          ephemeral: a.ephemeral ? 1 : 0,
          maxParallelism: a.maxParallelism as number,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function getAgentsInfo(hubPort: number, mint: () => Promise<string | null>): Promise<AgentInfo[]> {
  const db = await readFromDb();
  const base = (db ? db.agents : await agentsFromApi(hubPort, mint)).filter((a) => a.name);
  // Probe liveness for all agents concurrently — one round-trip total, not one per agent.
  const online = await Promise.all(base.map((a) => isOnline(hubPort, a.name!)));
  return base.map((a, i) => {
    const busy = db ? db.busy.has(a.name!) : false;
    const labels = db && a.id !== undefined ? (db.labels.get(a.id) ?? []) : [];
    return {
      id: a.id,
      poolId: a.poolId,
      name: a.name!,
      version: a.version,
      os: a.os,
      ephemeral: !!a.ephemeral,
      maxParallelism: a.maxParallelism,
      labels,
      online: online[i],
      busy,
      state: online[i] ? (busy ? "active" : "idle") : "offline",
    };
  });
}

// ── Per-run execution metadata (which runner ran it, when, how long) ──────────
/**
 * How a run actually executed, derived from the hub's own DB: the runner(s) that ran its jobs
 * (TimeLineRecords.WorkerName), when it started/finished, and the wall-clock duration. Read-only.
 * Only runs a runner actually picked up have Job timeline records, so a run with no entry here
 * simply never ran on the fleet (rendered without these extras rather than with fabricated ones).
 */
export interface RunMeta {
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  runners: string[];
}

/** Parse the hub's "YYYY-MM-DD HH:MM:SS.ffffff" (UTC) timestamps into epoch ms, or NaN. */
function parseHubTime(s: string): number {
  // Space→T and an explicit Z; JS truncates sub-millisecond digits, which is fine for a duration.
  return Date.parse(`${s.replace(" ", "T")}Z`);
}

/**
 * Execution metadata for every run that ran on the fleet, keyed by run id, read from the hub DB.
 * Returns an empty map when the DB can't be read (not co-located / experimental sqlite absent).
 */
export async function readRunMeta(hubDb: string = hubDbPath()): Promise<Map<number, RunMeta>> {
  const out = new Map<number, RunMeta>();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(hubDb, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT j.runid AS runid, t.WorkerName AS worker, t.StartTime AS started, t.FinishTime AS finished
           FROM Jobs j JOIN TimeLineRecords t ON t.TimelineId = j.TimeLineId AND t.RecordType = 'Job'`,
        )
        .all() as unknown as { runid: number; worker: string | null; started: string | null; finished: string | null }[];
      for (const r of rows) {
        const m = out.get(r.runid) ?? { runners: [] as string[] };
        if (r.worker && !m.runners.includes(r.worker)) m.runners.push(r.worker);
        // Fixed-width UTC strings compare lexicographically, so min start / max finish are string min/max.
        if (r.started && (!m.startedAt || r.started < m.startedAt)) m.startedAt = r.started;
        if (r.finished && (!m.finishedAt || r.finished > m.finishedAt)) m.finishedAt = r.finished;
        out.set(r.runid, m);
      }
      for (const m of out.values()) {
        if (m.startedAt && m.finishedAt) {
          const d = parseHubTime(m.finishedAt) - parseHubTime(m.startedAt);
          if (Number.isFinite(d) && d >= 0) m.durationMs = d;
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* DB unavailable → empty map (callers render runs without the extras) */
  }
  return out;
}

/** Exposed for tests. */
export const __test = { parseHubTime };
