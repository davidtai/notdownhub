/*
  Hub API client. Shapes below were verified empirically with curl against a live
  `ndh hub up` instance. Requests are same-origin: in production the ndh front
  server serves this app and proxies /_apis and /api to the hub; in dev, vite
  proxies to the developer's own test hub (see vite.config.ts).

  Envelope note: some endpoints return a bare array, others an OData-ish
  { value: [...] } wrapper — `unwrap` handles both.
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
  /** Not guaranteed by the runs list; used only when present (never fabricated). */
  createdOn?: string | null;
}

export interface Attempt {
  id: number;
  attempt: number;
  eventName?: string | null;
  /** Full workflow YAML for this attempt. Retained for reference; not parsed here. */
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
  /** Stable YAML job key; matrix legs share it (used to group legs under a parent). */
  workflowIdentifier: string;
  /** JSON string of the matrix combination, or null for the matrix parent / plain job. */
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

/** A runner as reported by the hub's local dashboard endpoint (GET /api/local/agents). */
export interface RunnerInfo {
  id: number | string;
  /** Pool the runner belongs to; with `id` it addresses the unregister endpoint. May be absent on older hubs. */
  poolId?: number;
  name: string;
  version?: string;
  os?: string;
  ephemeral?: boolean;
  maxParallelism?: number;
  labels: string[];
  online: boolean;
  busy: boolean;
  state: "active" | "idle" | "offline";
}

export interface JobLogs {
  /** false for runs predating log retention — render the "not retained" note, not an empty pane. */
  retained: boolean;
  lines: string[];
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

/** Fleet, from the hub's local dashboard endpoint. Returns [] on any failure. */
export async function getAgents(): Promise<RunnerInfo[]> {
  const data = await getJson<RunnerInfo[] | { value?: RunnerInfo[] }>(`/api/local/agents`);
  return unwrap(data);
}

/**
 * Unregister a runner from the hub. Mirrors `config.sh remove`'s hub step: DELETE
 * /_apis/v1/Agent/{poolId}/{agentId}. The ndh front injects the management JWT for
 * this anonymous DELETE (same AgentManagement scope as the read path). This only
 * removes the agent from the hub — the instance directory on the runner's machine
 * is cleaned separately with `ndh runner remove`.
 */
export async function removeAgent(poolId: number | string, agentId: number | string): Promise<void> {
  const res = await fetch(`/_apis/v1/Agent/${poolId}/${agentId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /_apis/v1/Agent/${poolId}/${agentId} → ${res.status} ${res.statusText}`);
}

/**
 * Persisted console for a completed job. Live logs are ephemeral in the hub, so
 * a finished run reads its output from here. `retained: false` means the run
 * predates retention — the caller shows a note rather than an empty pane.
 */
export async function getJobLogs(runId: number, timelineId: string): Promise<JobLogs> {
  try {
    const res = await fetch(`/api/local/joblogs/${runId}/${timelineId}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { retained: false, lines: [] };
    const body = (await res.json()) as { retained?: boolean; lines?: unknown };
    return {
      retained: !!body.retained,
      lines: Array.isArray(body.lines) ? (body.lines as string[]) : [],
    };
  } catch {
    return { retained: false, lines: [] };
  }
}

// ── Artifacts ────────────────────────────────────────────────────────────────
/** One uploaded artifact on a run, from GET /api/local/artifacts/<runId>. */
export interface ArtifactSummary {
  /** Container id — the id used to download it. */
  id: number;
  name: string;
  /** Archive size in bytes. */
  size: number;
}

/**
 * A run's artifacts. Served by the front (local-only) from the hub's own artifact
 * storage. Returns [] for a run with no artifacts, and swallows errors so the
 * run-detail page simply hides the section rather than showing an error.
 */
export async function getArtifacts(runId: number): Promise<ArtifactSummary[]> {
  try {
    const data = await getJson<ArtifactSummary[] | { value?: ArtifactSummary[] }>(`/api/local/artifacts/${runId}`);
    return unwrap(data);
  } catch {
    return [];
  }
}

/** Same-origin URL that streams an artifact's archive (Content-Disposition attachment). */
export function artifactDownloadUrl(runId: number, name: string): string {
  return `/api/local/artifacts/${runId}/${encodeURIComponent(name)}`;
}

// ── Settings (read-only view of secrets/variables) ──────────────────────────
export interface ConfigInfo {
  /** Where secrets live: keychain / libsecret / file. */
  backend: string;
  /** Secret names only — values are never sent to the browser. */
  secrets: { scope: string; name: string }[];
  /** Variables are non-sensitive, so their values are shown. */
  vars: { scope: string; name: string; value: string }[];
}

/** GET /api/local/config — names of stored secrets + variable values, local-only gated. */
export async function getConfig(): Promise<ConfigInfo> {
  const d = await getJson<Partial<ConfigInfo>>(`/api/local/config`);
  return { backend: d.backend ?? "unknown", secrets: d.secrets ?? [], vars: d.vars ?? [] };
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
 * GET /api/local/join-info — the hub returns pairing details only to the local
 * operator (loopback) or an authenticated remote (basic auth). A 403 means the
 * UI is local-only. We never guess the token: either the hub hands it to an
 * authorized caller, or we show a placeholder and point at where it lives.
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
