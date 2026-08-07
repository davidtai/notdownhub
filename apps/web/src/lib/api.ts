import { parse as parseYaml } from "yaml";

/*
  Hub API client. Shapes below were verified empirically with curl against a live
  `ndh hub up` instance (runner.server 3.14.0) — see PR description. Requests are
  same-origin: in production the ndh front server serves this app and proxies
  /_apis to the hub (injecting the read-only management JWT for Agent* routes);
  in dev, vite proxies to the developer's own test hub.
*/

export interface WorkflowRun {
  id: number;
  fileName?: string;
  displayName?: string;
  eventName?: string | null;
  ref?: string | null;
  sha?: string | null;
  result?: string | null;
  status?: string | null;
  owner?: string | null;
  repo?: string | null;
}

export interface Attempt {
  id: number;
  attempt: number;
  eventName?: string | null;
  /** Full workflow YAML for this attempt — the source of truth for `needs` edges. */
  workflow?: string | null;
  eventPayload?: string | null;
  timeLineId: string;
  ref?: string | null;
  sha?: string | null;
  result?: string | null;
  status?: string | null;
}

export interface Job {
  jobId: string;
  requestId: number;
  timeLineId: string;
  name: string;
  /** Stable YAML job key; matrix expansions share it (used to map to a `needs` node). */
  workflowIdentifier: string;
  /** JSON string of the matrix combination, or null for the (hidden) matrix parent. */
  matrix: string | null;
  workflowname?: string;
  runid: number;
  result?: string | null;
  status?: string | null;
  attempt: number;
  repo?: string;
}

export interface TimelineRecord {
  id: string;
  parentId: string | null;
  type: string; // "Job" | "Task" | "workflow" | …
  name: string;
  startTime: string | null;
  finishTime: string | null;
  state: string | null;
  result: string | null;
  percentComplete: number | null;
  order?: number;
  workerName?: string | null;
  log?: { id: number } | null;
}

export interface Agent {
  id: number;
  name?: string;
  version?: string;
  osDescription?: string;
  ephemeral?: boolean;
  status?: number | string;
  provisioningState?: string;
  maxParallelism?: number;
  // NB: the Agent API does not return runner labels; kept optional/defensive.
  labels?: { name?: string }[];
}

export interface Pool {
  id: number;
  name?: string;
}

export interface Runner extends Agent {
  poolName?: string;
  /** Authoritative liveness from GET /Message/isagentonline (an open runner session). */
  live?: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

// Some endpoints return a bare array, others an OData-ish { value: [...] } envelope.
function unwrap<T>(data: T[] | { value?: T[] } | null | undefined): T[] {
  if (!data) return [];
  return Array.isArray(data) ? data : (data.value ?? []);
}

export function getRuns(page = 0): Promise<WorkflowRun[]> {
  return getJson<WorkflowRun[]>(`/_apis/v1/Message/workflow/runs?page=${page}`);
}

export function getAttempts(runId: number): Promise<Attempt[]> {
  return getJson<Attempt[]>(`/_apis/v1/Message/workflow/run/${runId}/attempts`);
}

export function getJobs(runId: number, attempt: number): Promise<Job[]> {
  return getJson<Job[]>(`/_apis/v1/Message/workflow/run/${runId}/attempt/${attempt}/jobs`);
}

export function getTimeline(timelineId: string): Promise<TimelineRecord[]> {
  return getJson<TimelineRecord[]>(`/_apis/v1/Timeline/${timelineId}`);
}

// ── Pairing ─────────────────────────────────────────────────────────────────
export interface JoinInfo {
  host: string;
  port: number;
  /** The real registration token — only returned to loopback or basic-auth clients. */
  token: string | null;
  authEnabled: boolean;
}

export type JoinInfoResult =
  | { ok: true; info: JoinInfo }
  | { ok: false; status: number };

/**
 * GET /api/local/join-info — the hub's front server returns pairing details only
 * to the local operator (loopback) or an authenticated remote (basic auth). A 403
 * means the UI is local-only (no basic auth configured); a 401 means auth required.
 * We never guess the token: either the hub hands it to an authorized caller, or we
 * show a placeholder and point at where it lives.
 */
export async function getJoinInfo(): Promise<JoinInfoResult> {
  try {
    const res = await fetch("/api/local/join-info", { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, info: (await res.json()) as JoinInfo };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * Real-time liveness. The Agent record's `status` field is not maintained on
 * disconnect (it reads 0/"Provisioned" even for a runner that has gone away), so
 * we ask the hub which agents currently hold an open session:
 *   GET /_apis/v1/Message/isagentonline?name=<name> → { online } (404 when offline).
 */
export async function isAgentOnline(name: string): Promise<boolean> {
  try {
    const res = await fetch(`/_apis/v1/Message/isagentonline?name=${encodeURIComponent(name)}`);
    if (!res.ok) return false;
    const body = (await res.json()) as { online?: boolean };
    return !!body.online;
  } catch {
    return false;
  }
}

/**
 * Fleet = every agent across every pool, tagged with its pool name and live state.
 * Sourced from AgentPools → Agent/{poolId} → isagentonline/{name}. NB: the Agent
 * read API does not return runner labels, so cards render only the fields it exposes.
 */
export async function getFleet(): Promise<Runner[]> {
  const pools = unwrap(await getJson<Pool[] | { value: Pool[] }>(`/_apis/v1/AgentPools`));
  const out: Runner[] = [];
  for (const pool of pools) {
    const agents = unwrap(await getJson<Agent[] | { value: Agent[] }>(`/_apis/v1/Agent/${pool.id}`));
    for (const a of agents) out.push({ ...a, poolName: pool.name });
  }
  await Promise.all(
    out.map(async (r) => {
      r.live = r.name ? await isAgentOnline(r.name) : false;
    }),
  );
  return out;
}

// ── DAG derivation ────────────────────────────────────────────────────────────
// The jobs API has no explicit dependency edges, but each attempt carries the full
// workflow YAML. Parsing `needs:` gives real edges; depth (longest path from a root)
// determines the left-to-right column each job sits in.

export interface JobGraph {
  /** job key → list of job keys it depends on */
  needs: Record<string, string[]>;
  /** job key → column index (0 = no dependencies) */
  depth: Record<string, number>;
  /** whether edges came from the YAML (true) or a completion-order fallback (false) */
  derivedFromNeeds: boolean;
}

export function buildGraph(workflowYaml?: string | null, jobKeys: string[] = []): JobGraph {
  const needs: Record<string, string[]> = {};
  let derivedFromNeeds = false;

  if (workflowYaml) {
    try {
      const doc = parseYaml(workflowYaml) as { jobs?: Record<string, { needs?: string | string[] }> };
      const jobs = doc?.jobs ?? {};
      for (const [key, def] of Object.entries(jobs)) {
        const n = def?.needs;
        needs[key] = n ? (Array.isArray(n) ? n : [n]) : [];
      }
      derivedFromNeeds = Object.keys(needs).length > 0;
    } catch {
      // fall through to fallback
    }
  }

  // Fallback: no parseable needs → lay every known job in a single column.
  if (!derivedFromNeeds) {
    for (const k of jobKeys) needs[k] = [];
  }

  const depth: Record<string, number> = {};
  const compute = (key: string, seen: Set<string>): number => {
    if (depth[key] !== undefined) return depth[key];
    if (seen.has(key)) return 0; // guard against cycles
    seen.add(key);
    const parents = needs[key] ?? [];
    const d = parents.length ? Math.max(...parents.map((p) => compute(p, seen) + 1)) : 0;
    depth[key] = d;
    return d;
  };
  for (const key of Object.keys(needs)) compute(key, new Set());

  return { needs, depth, derivedFromNeeds };
}
