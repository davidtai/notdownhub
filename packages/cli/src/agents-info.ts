import { join } from "node:path";
import { ndhHome } from "./lib.js";

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
  name: string;
  version?: string;
  os?: string;
  ephemeral?: number;
  maxParallelism?: number;
}

function dbPath(): string {
  return join(ndhHome(), "hub", "hub.db");
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
    const db = new DatabaseSync(dbPath(), { readOnly: true });
    try {
      const agents = db
        .prepare(
          `SELECT t.Id AS id, t.Name AS name, t.Version AS version, t.OSDescription AS os,
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
    const unwrap = (d: unknown): unknown[] =>
      Array.isArray(d) ? d : ((d as { value?: unknown[] })?.value ?? []);
    const pools = unwrap(await fetch(`http://127.0.0.1:${hubPort}/_apis/v1/AgentPools`, { headers }).then((r) => r.json()));
    const out: BaseAgent[] = [];
    for (const p of pools as { id: number }[]) {
      const agents = unwrap(await fetch(`http://127.0.0.1:${hubPort}/_apis/v1/Agent/${p.id}`, { headers }).then((r) => r.json()));
      for (const a of agents as Record<string, unknown>[]) {
        out.push({
          id: a.id as number,
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
  const base = db ? db.agents : await agentsFromApi(hubPort, mint);
  const out: AgentInfo[] = [];
  for (const a of base) {
    if (!a.name) continue;
    const online = await isOnline(hubPort, a.name);
    const busy = db ? db.busy.has(a.name) : false;
    const labels = db && a.id !== undefined ? (db.labels.get(a.id) ?? []) : [];
    out.push({
      id: a.id,
      name: a.name,
      version: a.version,
      os: a.os,
      ephemeral: !!a.ephemeral,
      maxParallelism: a.maxParallelism,
      labels,
      online,
      busy,
      state: online ? (busy ? "active" : "idle") : "offline",
    });
  }
  return out;
}
