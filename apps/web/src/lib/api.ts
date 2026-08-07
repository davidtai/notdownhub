/*
  Hub API client. Shapes below were verified empirically with curl against a live
  `ndh hub up` instance. Requests are same-origin: in production the ndh front
  server serves this app and proxies /_apis and /api to the hub; in dev, vite
  proxies to the developer's own test hub (see vite.config.ts).

  Envelope note: some endpoints return a bare array, others an OData-ish
  { value: [...] } wrapper — `unwrap` handles both.
*/
import { timelineSpan } from "./format";
import type { Project } from "./projects";

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

/**
 * A single annotation the engine attached to a timeline record — the same data
 * GitHub renders as inline annotations. `type` is "warning" | "error" | "notice".
 * We consume these directly rather than scraping `##[warning]` text from the log.
 */
export interface Issue {
  type?: string | null;
  category?: string | null;
  message?: string | null;
  data?: { title?: string; stepNumber?: string; logFileLineNumber?: string } | null;
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
  /** Engine annotations for this record (warnings, non-fatal errors, notices). */
  issues?: Issue[] | null;
  errorCount?: number | null;
  warningCount?: number | null;
  noticeCount?: number | null;
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

// ── Run timing (batch, from the hub DB via the front) ───────────────────────
/**
 * Real execution times for one run, from GET /api/local/runs-meta (issue #96).
 * The engine's runs list carries no time field; the hub DB's Job timeline
 * records do — the same source `ndh status` reads. All times are ISO-8601 UTC.
 * An in-progress run has startedAt only; a run never picked up has no entry.
 */
export interface RunTimeMeta {
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

/**
 * Batch-fetch timing for a page of run ids in ONE request (never one per row).
 * Returns the id-keyed map; unknown ids are simply absent. Returns null when
 * the endpoint is unavailable (older hub, non-OK, network error) so callers can
 * distinguish "no data yet" from "these runs have no recorded times".
 */
export async function getRunsMeta(ids: number[]): Promise<Record<number, RunTimeMeta> | null> {
  if (ids.length === 0) return {};
  try {
    const res = await fetch(`/api/local/runs-meta?ids=${ids.join(",")}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<number, RunTimeMeta> | null;
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
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

// ── Projects (derived from run history) ──────────────────────────────────────

/**
 * The complete run history, via the engine's unpaged runs list (omitting `page`
 * returns every run, not one 30-run page). Fallback source for the Projects
 * page when /api/local/projects is absent (older hub) — deriving projects from
 * a single page silently drops projects whose runs sit on later pages (#90).
 */
export async function getAllRuns(): Promise<WorkflowRun[]> {
  const data = await getJson<WorkflowRun[] | { value?: WorkflowRun[] }>(`/_apis/v1/Message/workflow/runs`);
  return unwrap(data);
}

/**
 * The distinct-projects list across the FULL run history, aggregated hub-side
 * (GET /api/local/projects, issue #90) — counts, last run, and the per-workflow
 * breakdown, with deleted runs already excluded. Returns null when the endpoint
 * is unavailable (older hub, or any failure) so the caller can fall back to
 * deriving the same list client-side from the unpaged runs list.
 */
export async function getProjects(): Promise<Project[] | null> {
  try {
    const res = await fetch(`/api/local/projects`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as Project[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// ── Planned-project placeholders (#113) ─────────────────────────────────────

/** What the wizard sends to create a placeholder — the facts parsed from the workflow YAML. */
export interface PlaceholderInput {
  slug: string;
  workflowFileName: string | null;
  workflowName: string | null;
  events: string[];
  branches: string[];
  runsOn: string[];
}

export interface PlaceholderResult {
  ok: boolean;
  status: number;
}

/**
 * Create (or replace) a planned-project placeholder via the front's gated
 * store — POST /api/local/projects/placeholder. The project then shows as
 * `planned` on the Projects surface until its first real run absorbs it.
 */
export async function createProjectPlaceholder(input: PlaceholderInput): Promise<PlaceholderResult> {
  try {
    const res = await fetch(`/api/local/projects/placeholder`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Remove a planned-project placeholder (the "Remove" action on a planned card). */
export async function deleteProjectPlaceholder(slug: string): Promise<PlaceholderResult> {
  try {
    const res = await fetch(`/api/local/projects/placeholder?slug=${encodeURIComponent(slug)}`, {
      method: "DELETE",
      headers: { accept: "application/json" },
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ── Job display aliases (#114) ──────────────────────────────────────────────

/**
 * One display alias: for `project`, the job keyed `jobKey` (the stable YAML
 * job key — the engine's `workflowIdentifier`) renders as `alias`. ALIAS,
 * NEVER OVERRIDE: the engine's job records are untouched, and the original
 * name stays recoverable (tooltip) until the alias is cleared.
 */
export interface JobAlias {
  project: string;
  jobKey: string;
  alias: string;
}

/** All stored aliases (GET /api/local/job-aliases). Tolerant: [] on any failure. */
export async function getJobAliases(): Promise<JobAlias[]> {
  try {
    const res = await fetch(`/api/local/job-aliases`, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const rows = (await res.json()) as JobAlias[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Set (or replace) a job display alias. Returns whether the hub accepted it. */
export async function setJobAlias(project: string, jobKey: string, alias: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/local/job-aliases`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ project, jobKey, alias }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Clear a job display alias — the original name shows again everywhere. */
export async function clearJobAlias(project: string, jobKey: string): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/local/job-aliases?project=${encodeURIComponent(project)}&jobKey=${encodeURIComponent(jobKey)}`,
      { method: "DELETE", headers: { accept: "application/json" } },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** The alias for a project + job key from a loaded alias list, or null. */
export function aliasFor(aliases: JobAlias[], project: string | null, jobKey: string): string | null {
  if (!project) return null;
  return aliases.find((a) => a.project === project && a.jobKey === jobKey)?.alias ?? null;
}

/** The workflow definition recorded with a run: its YAML plus the attempt's timeline id. */
export interface WorkflowDefinition {
  /** Full workflow YAML the hub retained for the run's latest attempt, or null if none. */
  yaml: string | null;
  /** Timeline of the latest attempt (workflow-level; empty of timings — jobs carry those). */
  timelineId: string | null;
}

/**
 * The workflow definition the hub recorded with a run. The engine retains the
 * dispatched YAML byte-for-byte on each attempt, so the Projects view renders the
 * latest known definition per workflow from here — no shadow store. Never throws;
 * degrades to nulls so the page can say "definition not retained" honestly.
 */
export async function getWorkflowDefinition(runId: number): Promise<WorkflowDefinition> {
  try {
    const attempts = await getAttempts(runId);
    if (attempts.length === 0) return { yaml: null, timelineId: null };
    const latest = attempts.reduce((a, b) => (b.attempt > a.attempt ? b : a));
    return { yaml: latest.workflow ?? null, timelineId: latest.timeLineId ?? null };
  } catch {
    return { yaml: null, timelineId: null };
  }
}

/**
 * Real wall-clock time of a run's last activity, for the Projects list. The runs
 * list and the run/attempt records carry no timestamp; only the per-job timelines
 * do. So we walk the latest attempt's jobs → their timelines → the widest span.
 * Returns an ISO string or null (never throws) — the caller renders relative time
 * only when a real value exists, never a fabricated one.
 */
export async function getRunLastActivity(runId: number): Promise<string | null> {
  try {
    const attempts = await getAttempts(runId);
    if (attempts.length === 0) return null;
    const latest = attempts.reduce((a, b) => (b.attempt > a.attempt ? b : a));
    const jobs = await getJobs(runId, latest.attempt);
    const timelines = await Promise.all(jobs.map((j) => getTimeline(j.timeLineId).catch(() => [] as TimelineRecord[])));
    const span = timelineSpan(timelines.flat());
    return span.finish ?? span.start;
  } catch {
    return null;
  }
}

export interface DeleteResult {
  ok: boolean;
  status: number;
}

/**
 * Cheap capability probe for the project-delete backend (#60). Returns true only
 * when the `/api/local/runs` route is actually handled — an OPTIONS that comes
 * back anything other than 404 means the path exists (the hub answers it). Until
 * #60 lands the route is unmapped and the front proxies OPTIONS through to the
 * engine, which 404s — so this returns false and the caller hides the Remove
 * control entirely rather than shipping a button that errors when clicked.
 *
 * The moment #60 adds the endpoint, this flips to true and Remove appears with no
 * further change here. Contract for #60: register the `/api/local/runs` path so a
 * non-DELETE method (OPTIONS) resolves with a non-404 status.
 */
export async function probeDeleteProjectSupport(): Promise<boolean> {
  try {
    const res = await fetch("/api/local/runs", {
      method: "OPTIONS",
      headers: { accept: "application/json" },
    });
    return res.status !== 404;
  } catch {
    return false;
  }
}

/**
 * Bulk-delete every run + persisted job log belonging to a project — the action
 * behind the Projects "Remove" button. A project is derived from its runs, so
 * removing it means truly deleting those runs (issue #55 → #60), not hiding them.
 *
 * Wired to #60's contract (`ndh run delete --project <owner/repo>`, exposed as
 * DELETE /api/local/runs?project=<owner/repo>). The Remove control is only shown
 * when probeDeleteProjectSupport() confirms the route exists, so this is never
 * called against a missing endpoint in normal use.
 */
export async function deleteProjectRuns(project: string): Promise<DeleteResult> {
  try {
    const res = await fetch(`/api/local/runs?project=${encodeURIComponent(project)}`, {
      method: "DELETE",
      headers: { accept: "application/json" },
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ── Run control (cancel / true delete) ──────────────────────────────────────
/**
 * Cancel a running run through the front's gated endpoint. The front drives the engine's
 * forceCancelWorkflow — the reliable stop, and the recovery for an orphaned dispatch (a run
 * left stuck "running" with the runner busy). Throws on a non-OK response.
 */
export async function cancelRun(id: number): Promise<void> {
  const res = await fetch(`/api/local/runs/${id}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(`cancel run ${id} → ${res.status} ${res.statusText}`);
}

/**
 * Truly delete a run: the front tombstones it and purges its persisted logs, so it is gone from
 * the list, 404s on detail, and stays gone across restarts. Throws on a non-OK response.
 */
export async function deleteRun(id: number): Promise<void> {
  const res = await fetch(`/api/local/runs/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete run ${id} → ${res.status} ${res.statusText}`);
}

/**
 * Re-run a finished run on the fleet. The bundled Runner.Server exposes a native
 * re-run that re-queues the recorded workflow (retained per attempt: full YAML +
 * event + ref/sha) as a NEW ATTEMPT of the same run — GitHub's "Re-run"
 * semantics — so the re-run stays attributed to the same project and is linked
 * to the original by id. Anonymous POST is accepted through the front proxy (the
 * endpoint needs no management JWT, unlike the Agent* reads).
 *
 *   POST /_apis/v1/Message/rerunworkflow/{id}   re-run the whole workflow
 *   POST /_apis/v1/Message/rerunFailed/{id}     re-run only the failed jobs
 *
 * Local dispatches (#110): the hub retains the dispatched tree per run, and the
 * re-run replay re-wires the localcheckout substitution, so re-runs check out
 * that retained tree. When the tree is not on the hub (runs from before that
 * retention) the hub REFUSES with one honest JSON message — surfaced here as the
 * thrown Error's message so the button can show it verbatim.
 */
export async function rerunWorkflow(runId: number, opts: { failed?: boolean } = {}): Promise<void> {
  const verb = opts.failed ? "rerunFailed" : "rerunworkflow";
  const path = `/_apis/v1/Message/${verb}/${runId}`;
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) {
    let reason: string | null = null;
    try {
      reason = ((await res.json()) as { error?: string })?.error ?? null;
    } catch {
      /* not JSON — keep the generic status line */
    }
    if (reason) throw new HubRefusalError(reason);
    throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
  }
}

/** A deliberate hub-side refusal whose message is meant for the operator's eyes, verbatim. */
export class HubRefusalError extends Error {}

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
