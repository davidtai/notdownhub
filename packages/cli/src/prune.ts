import { existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ndhHome, hubDbPath, log } from "./lib.js";

/**
 * Bounded retention for a hub's growth surfaces (issue #67). Only joblogs auto-prune at 14 days;
 * everything else — the hub.db run records, their timeline/log/artifact rows, the on-disk artifact
 * blobs, and the action mirror cache — grows forever, so old runs end up as rows whose logs already
 * vanished. This module trims all of them together, on an age (`--older-than`) and/or per-project
 * keep-count (`--keep-last`) policy, and reports (or, with a real run, frees) bytes per category.
 *
 * The no-orphan invariant: when a run is pruned, ALL of its dependent state goes with it in one
 * transaction — every WorkflowRunAttempt, Job, TimeLineRecord (+ its issues/variables/log rows),
 * Artifact chain (+ the blob file on disk), and the run's joblogs rows. A run whose logs or
 * artifacts have vanished — the exact #67 complaint — is never created by this command.
 *
 * Safety: only *completed* runs are ever touched (WorkflowRunAttempt.Status == Completed), so an
 * in-progress run's data is never deleted out from under the running Runner.Server. hub.db is opened
 * read/write with a busy timeout; deletions are transactional; blob/mirror files are unlinked only
 * after the DB rows referencing them are gone, so we can leak bytes on a failed unlink but never
 * orphan a record pointing at a missing file.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any; // node:sqlite DatabaseSync — typed loosely; the module is experimental.

const DAY_MS = 24 * 60 * 60 * 1000;

/** WorkflowRunAttempt.Status (runner.server Status enum): a run is prunable only when Completed. */
export const STATUS_COMPLETED = 4;

// ── paths ─────────────────────────────────────────────────────────────────────
export function joblogsDbPath(): string {
  return join(ndhHome(), "hub", "joblogs.db");
}

export function mirrorDir(): string {
  return join(ndhHome(), "mirror");
}

/**
 * Directory holding uploaded artifact blob files, named by ArtifactRecords.StoreName. The vendored
 * Runner.Server stores them via GharunUtil.GetLocalStorage()+"/artifacts" — a global location that
 * is NOT under NDH_HOME: $XDG_DATA_HOME (or ~/.local/share) then "runner.server" (preferred) or the
 * legacy "gharun" root. `NDH_ARTIFACTS_DIR` overrides it (used by tests and by operators whose hub
 * runs with a non-default storage root).
 */
export function artifactsDir(): string {
  const override = process.env.NDH_ARTIFACTS_DIR;
  if (override) return override;
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const root = existsSync(join(base, "runner.server"))
    ? "runner.server"
    : existsSync(join(base, "gharun"))
      ? "gharun"
      : "runner.server";
  return join(base, root, "artifacts");
}

// ── db open ─────────────────────────────────────────────────────────────────
/** Open hub.db (read/write unless readOnly). A busy timeout lets us coexist with a live hub. */
export async function openHubDb(path: string, readOnly = false): Promise<Db> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly });
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

// ── time parsing ──────────────────────────────────────────────────────────────
/**
 * Parse a Runner.Server timestamp ("2026-08-06 23:21:15.531166", UTC, no zone) to epoch ms, or null.
 * Fractional seconds are dropped — retention is day-grained so sub-second precision is irrelevant,
 * and Date.parse does not accept arbitrary fractional-digit counts reliably.
 */
export function parseHubTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const norm = s.trim().replace(" ", "T").replace(/\.\d+$/, "");
  const t = Date.parse(`${norm}Z`);
  return Number.isNaN(t) ? null : t;
}

// ── run model ─────────────────────────────────────────────────────────────────
export interface RunInfo {
  runId: number;
  project: string;
  /** Last activity epoch ms (max finish/start over the run's timeline records), or null if unknown. */
  ts: number | null;
  completed: boolean;
  attemptIds: number[];
  jobIds: string[];
  /** Every timeline id belonging to the run: the attempt (workflow) timelines and the job timelines. */
  timelineIds: string[];
  /** Job timelines only, lower-cased — the key joblogs.db stores (its feed emits lower-case ids). */
  jobTimelineIdsLower: string[];
}

interface AttemptRow {
  Id: number;
  WorkflowRunId: number | null;
  Status: number;
  TimeLineId: string | null;
}
interface JobRow {
  JobId: string;
  WorkflowRunAttemptId: number | null;
  TimeLineId: string | null;
  repo: string | null;
}
interface RunMetaRow {
  Id: number;
  FileName: string | null;
}

/** owner/repo, ignoring the "Unknown/Unknown" the server writes when it cannot resolve one. */
function normalizeRepo(repo: string | null | undefined): string | null {
  const r = repo?.trim();
  if (!r || r === "Unknown/Unknown") return null;
  return r;
}

/** Load every run with its attempts, jobs, timelines, project, completion state, and last-activity ts. */
export function loadRuns(db: Db): RunInfo[] {
  const runsMeta = db.prepare("SELECT Id, FileName FROM WorkflowRun").all() as RunMetaRow[];
  const attempts = db.prepare("SELECT Id, WorkflowRunId, Status, TimeLineId FROM WorkflowRunAttempt").all() as AttemptRow[];
  const jobs = db.prepare("SELECT JobId, WorkflowRunAttemptId, TimeLineId, repo FROM Jobs").all() as JobRow[];
  // Last-activity per timeline: the job timelines carry real Start/Finish times (LastModified is
  // never updated by the server, so it is useless for age). Keyed lower-case for stable joins.
  const tlRows = db
    .prepare("SELECT TimelineId AS tl, MAX(FinishTime) AS f, MAX(StartTime) AS s FROM TimeLineRecords GROUP BY TimelineId")
    .all() as { tl: string | null; f: string | null; s: string | null }[];
  const tlTime = new Map<string, number | null>();
  for (const r of tlRows) {
    if (!r.tl) continue;
    tlTime.set(r.tl.toLowerCase(), parseHubTime(r.f) ?? parseHubTime(r.s));
  }

  const attemptsByRun = new Map<number, AttemptRow[]>();
  for (const a of attempts) {
    if (a.WorkflowRunId == null) continue;
    (attemptsByRun.get(a.WorkflowRunId) ?? attemptsByRun.set(a.WorkflowRunId, []).get(a.WorkflowRunId)!).push(a);
  }
  const jobsByAttempt = new Map<number, JobRow[]>();
  for (const j of jobs) {
    if (j.WorkflowRunAttemptId == null) continue;
    (jobsByAttempt.get(j.WorkflowRunAttemptId) ?? jobsByAttempt.set(j.WorkflowRunAttemptId, []).get(j.WorkflowRunAttemptId)!).push(j);
  }

  const out: RunInfo[] = [];
  for (const meta of runsMeta) {
    const runAttempts = attemptsByRun.get(meta.Id) ?? [];
    const attemptIds: number[] = [];
    const jobIds: string[] = [];
    const timelineIds = new Set<string>();
    const jobTimelineIdsLower: string[] = [];
    let ts: number | null = null;
    let project: string | null = null;
    // A run is prunable only if every attempt is Completed; an attempt with no attempts row at all
    // (a stray WorkflowRun) has no in-flight work, so it counts as completed.
    let completed = true;

    for (const a of runAttempts) {
      attemptIds.push(a.Id);
      if (a.Status !== STATUS_COMPLETED) completed = false;
      if (a.TimeLineId) timelineIds.add(a.TimeLineId);
      for (const j of jobsByAttempt.get(a.Id) ?? []) {
        jobIds.push(j.JobId);
        project = project ?? normalizeRepo(j.repo);
        if (j.TimeLineId) {
          timelineIds.add(j.TimeLineId);
          jobTimelineIdsLower.push(j.TimeLineId.toLowerCase());
          const t = tlTime.get(j.TimeLineId.toLowerCase());
          if (t != null && (ts == null || t > ts)) ts = t;
        }
      }
    }
    out.push({
      runId: meta.Id,
      project: project ?? normalizeRepo(meta.FileName) ?? meta.FileName?.trim() ?? "local",
      ts,
      completed,
      attemptIds,
      jobIds,
      timelineIds: [...timelineIds],
      jobTimelineIdsLower,
    });
  }
  return out;
}

// ── selection ───────────────────────────────────────────────────────────────
export interface RetentionOpts {
  olderThanDays?: number;
  keepLast?: number;
  now: number;
}

/**
 * Which completed runs retention would remove. `older-than` removes runs whose last activity is
 * before the cutoff (runs with no known timestamp are never age-pruned — we cannot prove they are
 * old). `keep-last N` always retains the N most-recent completed runs *per project*. With both, a
 * run is removed only if it is old AND outside its project's newest-N — so a busy project keeps a
 * floor of N recent runs even when they are older than the age cutoff.
 */
export function selectRuns(runs: RunInfo[], opts: RetentionOpts): RunInfo[] {
  const completed = runs.filter((r) => r.completed);
  const cutoff = opts.olderThanDays != null ? opts.now - opts.olderThanDays * DAY_MS : null;

  let eligible = completed;
  if (cutoff != null) eligible = completed.filter((r) => r.ts != null && r.ts < cutoff);

  if (opts.keepLast != null) {
    const keep = new Set<number>();
    const byProject = new Map<string, RunInfo[]>();
    for (const r of completed) {
      (byProject.get(r.project) ?? byProject.set(r.project, []).get(r.project)!).push(r);
    }
    for (const group of byProject.values()) {
      group
        .slice()
        .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0) || b.runId - a.runId)
        .slice(0, opts.keepLast)
        .forEach((r) => keep.add(r.runId));
    }
    eligible = eligible.filter((r) => !keep.has(r.runId));
  }
  return eligible;
}

// ── file listing ──────────────────────────────────────────────────────────────
export interface FileEntry {
  path: string;
  bytes: number;
  mtime: number;
}

/** Recursively list regular files under `dir` with size + mtime. Missing dir → empty. */
export function listFiles(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (d: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          const st = statSync(p);
          out.push({ path: p, bytes: st.size, mtime: st.mtimeMs });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  };
  walk(dir);
  return out;
}

/** Mirror cache files retention would remove — same age/LRU policy as runs, keyed on file mtime. */
export function selectMirror(files: FileEntry[], opts: RetentionOpts): FileEntry[] {
  const cutoff = opts.olderThanDays != null ? opts.now - opts.olderThanDays * DAY_MS : null;
  let del = files;
  if (cutoff != null) del = files.filter((f) => f.mtime < cutoff);
  if (opts.keepLast != null) {
    const keep = new Set(
      files
        .slice()
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, opts.keepLast)
        .map((f) => f.path),
    );
    del = del.filter((f) => !keep.has(f.path));
  }
  return del;
}

// ── artifact rows ─────────────────────────────────────────────────────────────
interface ArtifactRow {
  recordId: number; // ArtifactRecords.Id
  containerId: number; // ArtifactFileContainer.Id
  artifactId: number; // Artifacts.Id
  attemptId: number | null; // Artifacts.AttemptId
  storeName: string | null;
}

/** All artifact rows joined across the three tables, with the attempt (→run) each belongs to. */
export function loadArtifacts(db: Db): ArtifactRow[] {
  return db
    .prepare(
      `SELECT ar.Id AS recordId, ar.StoreName AS storeName, afc.Id AS containerId, a.Id AS artifactId, a.AttemptId AS attemptId
         FROM ArtifactRecords ar
         JOIN ArtifactFileContainer afc ON afc.Id = ar.FileContainerId
         JOIN Artifacts a ON a.Id = afc.ContainerId`,
    )
    .all() as ArtifactRow[];
}

// ── plan ──────────────────────────────────────────────────────────────────────
export interface BlobEntry {
  path: string;
  bytes: number;
}

export interface PrunePlan {
  // run-row deletion (ids, computed once so dry-run and execute delete exactly the same set)
  runIds: number[];
  attemptIds: number[];
  jobIds: string[];
  recordIds: string[]; // TimeLineRecords.Id
  logIds: number[]; // TaskLogReference.Id
  detailsIds: string[]; // TimelineReference.Id
  joblogsTimelineIds: string[]; // lower-cased job timelines to purge from joblogs.db
  // artifact-row deletion split: rows removed as part of a run vs. rows removed on their own
  // (retention-eligible artifacts of a run we are keeping), so the executor deletes the right rows.
  runArtifactRecordIds: number[];
  runArtifactContainerIds: number[];
  runArtifactIds: number[];
  onlyArtifactRecordIds: number[];
  onlyArtifactContainerIds: number[];
  onlyArtifactIds: number[];
  // on-disk files to unlink (blob files from runs + artifact-only + orphans; mirror files)
  blobs: BlobEntry[];
  mirrorFiles: FileEntry[];
  // report aggregates
  report: PruneCounts;
}

export interface PruneCounts {
  runs: number;
  attempts: number;
  jobs: number;
  timelineRecords: number;
  logs: number;
  artifactBlobs: number;
  artifactBytes: number;
  mirrorFiles: number;
  mirrorBytes: number;
  joblogsTimelines: number;
}

export interface PlanOpts extends RetentionOpts {
  runs: boolean;
  mirror: boolean;
  artifacts: boolean;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** File size in bytes, or 0 if it does not exist / cannot be stat'd. */
function safeBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Build the exact set of rows and files a prune would remove, without touching anything. Both
 * `--dry-run` and the real run consume this same plan, so what dry-run reports is precisely what a
 * real run deletes. At least one of older-than / keep-last must be set (guaranteed by the caller).
 */
export function buildPlan(hubDb: Db, opts: PlanOpts): PrunePlan {
  const runs = loadRuns(hubDb);
  const eligible = selectRuns(runs, opts);
  const eligibleIds = new Set(eligible.map((r) => r.runId));

  const runsToDelete = opts.runs ? eligible : [];
  const deleteRunIds = new Set(runsToDelete.map((r) => r.runId));

  // ── run-row ids ──
  const runIds = runsToDelete.map((r) => r.runId);
  const attemptIds = runsToDelete.flatMap((r) => r.attemptIds);
  const jobIds = runsToDelete.flatMap((r) => r.jobIds);
  const timelineIds = runsToDelete.flatMap((r) => r.timelineIds);
  const joblogsTimelineIds = runsToDelete.flatMap((r) => r.jobTimelineIdsLower);

  // TimeLineRecords (+ their log/details refs) for the runs' timelines.
  const recordIds: string[] = [];
  const logIds: number[] = [];
  const detailsIds: string[] = [];
  for (const c of chunk(timelineIds, 400)) {
    if (!c.length) continue;
    const rows = hubDb
      .prepare(`SELECT Id, LogId, DetailsId FROM TimeLineRecords WHERE TimelineId IN (${c.map(() => "?").join(",")}) COLLATE NOCASE`)
      .all(...c) as { Id: string; LogId: number | null; DetailsId: string | null }[];
    for (const r of rows) {
      recordIds.push(r.Id);
      if (r.LogId != null) logIds.push(r.LogId);
      if (r.DetailsId != null) detailsIds.push(r.DetailsId);
    }
  }

  // ── artifacts ──
  const allArtifacts = loadArtifacts(hubDb);
  const attemptToRun = new Map<number, number>();
  for (const r of runs) for (const a of r.attemptIds) attemptToRun.set(a, r.runId);

  const runArtifactRecordIds: number[] = [];
  const runArtifactContainerIds: number[] = [];
  const runArtifactIds: number[] = [];
  const onlyArtifactRecordIds: number[] = [];
  const onlyArtifactContainerIds: number[] = [];
  const onlyArtifactIds: number[] = [];
  const blobs: BlobEntry[] = [];
  const dir = artifactsDir();
  const referenced = new Set<string>();

  for (const a of allArtifacts) {
    if (a.storeName) referenced.add(a.storeName);
    const runId = a.attemptId != null ? attemptToRun.get(a.attemptId) : undefined;
    const blob = (): void => {
      if (a.storeName) blobs.push({ path: join(dir, a.storeName), bytes: safeBytes(join(dir, a.storeName)) });
    };
    if (runId != null && deleteRunIds.has(runId)) {
      // Deleted as part of the run: rows cascade with the run, blob file unlinked.
      runArtifactRecordIds.push(a.recordId);
      runArtifactContainerIds.push(a.containerId);
      runArtifactIds.push(a.artifactId);
      blob();
    } else if (opts.artifacts && runId != null && eligibleIds.has(runId)) {
      // Retention-eligible artifact of a run we are KEEPING: drop the artifact rows + blob only.
      onlyArtifactRecordIds.push(a.recordId);
      onlyArtifactContainerIds.push(a.containerId);
      onlyArtifactIds.push(a.artifactId);
      blob();
    }
  }

  // Orphan blob sweep: files on disk with no ArtifactRecords row pointing at them (e.g. left by a
  // crash mid-upload). Age-bounded and only when --older-than is given: the artifacts directory is a
  // GLOBAL Runner.Server storage location that may be shared by more than one hub, so we never
  // delete a recent unreferenced file — it could belong to another instance still writing it.
  if (opts.artifacts && opts.olderThanDays != null) {
    const cutoff = opts.now - opts.olderThanDays * DAY_MS;
    for (const f of listFiles(dir)) {
      const name = f.path.slice(dir.length + 1);
      if (!referenced.has(name) && f.mtime < cutoff) blobs.push({ path: f.path, bytes: f.bytes });
    }
  }

  // ── mirror ──
  const mirrorFiles = opts.mirror ? selectMirror(listFiles(mirrorDir()), opts) : [];

  const report: PruneCounts = {
    runs: runIds.length,
    attempts: attemptIds.length,
    jobs: jobIds.length,
    timelineRecords: recordIds.length,
    logs: logIds.length,
    artifactBlobs: blobs.length,
    artifactBytes: blobs.reduce((n, b) => n + b.bytes, 0),
    mirrorFiles: mirrorFiles.length,
    mirrorBytes: mirrorFiles.reduce((n, f) => n + f.bytes, 0),
    joblogsTimelines: new Set(joblogsTimelineIds).size,
  };

  return {
    runIds,
    attemptIds,
    jobIds,
    recordIds,
    logIds,
    detailsIds,
    joblogsTimelineIds,
    runArtifactRecordIds,
    runArtifactContainerIds,
    runArtifactIds,
    onlyArtifactRecordIds,
    onlyArtifactContainerIds,
    onlyArtifactIds,
    blobs,
    mirrorFiles,
    report,
  };
}

// ── execute ─────────────────────────────────────────────────────────────────
/** DELETE FROM <table> WHERE <col> IN (...) for possibly-large id lists, chunked under the SQLite limit. */
function delIn(db: Db, table: string, col: string, ids: (string | number)[]): void {
  for (const c of chunk(ids, 400)) {
    if (!c.length) continue;
    db.prepare(`DELETE FROM ${table} WHERE ${col} IN (${c.map(() => "?").join(",")})`).run(...c);
  }
}

export interface PruneResult {
  counts: PruneCounts;
  /** Actual bytes freed on disk (blob + mirror files that were really unlinked). */
  freedArtifactBytes: number;
  freedMirrorBytes: number;
  /** hub.db file bytes reclaimed by VACUUM, or null when it could not run (e.g. hub live / locked). */
  hubDbFreedBytes: number | null;
}

export interface ExecDeps {
  unlink?: (p: string) => void;
  bytesOf?: (p: string) => number;
  hubDbFileBytes?: () => number;
}

/**
 * Execute a plan. hub.db row deletions run in ONE transaction (child rows first, respecting the
 * foreign keys), so a run and all its dependents disappear atomically — no orphaned timeline, log,
 * or artifact rows. joblogs rows for the pruned runs are purged in a second transaction. Only after
 * the rows are gone do we unlink the blob and mirror files, then VACUUM to actually shrink hub.db.
 */
export function executePlan(hubDb: Db, joblogsDb: Db | null, plan: PrunePlan, deps: ExecDeps = {}): PruneResult {
  const unlink = deps.unlink ?? ((p: string) => unlinkSync(p));
  const bytesOf = deps.bytesOf ?? safeBytes;
  // On-disk footprint of hub.db is the main file plus its WAL and shared-memory sidecars.
  const hubBytes = deps.hubDbFileBytes ?? (() => safeBytes(hubDbPath()) + safeBytes(`${hubDbPath()}-wal`) + safeBytes(`${hubDbPath()}-shm`));
  // Capture the hub.db size up front: row deletes land in the WAL, so the main file only shrinks at
  // the VACUUM below — measuring before then would report ~0 reclaimed.
  const hubBytesBefore = plan.runIds.length ? hubBytes() : 0;

  // 1. hub.db rows, child-first, in one transaction.
  hubDb.exec("BEGIN");
  try {
    delIn(hubDb, "TimelineIssues", "RecordId", plan.recordIds);
    delIn(hubDb, "TimelineVariables", "RecordId", plan.recordIds);
    delIn(hubDb, "Logs", "RefId", plan.logIds);
    delIn(hubDb, "TimeLineRecords", "Id", plan.recordIds);
    delIn(hubDb, "TaskLogReference", "Id", plan.logIds);
    delIn(hubDb, "TimelineReference", "Id", plan.detailsIds);
    delIn(hubDb, "JobOutput", "JobId", plan.jobIds);
    // Artifact rows cascading with a pruned run: delete the record/container rows that have blobs,
    // then EVERY Artifacts row for the run's attempts — the server writes an empty Artifacts row per
    // attempt even with no uploads, and it must not be left orphaned when the attempt is deleted.
    delIn(hubDb, "ArtifactRecords", "Id", plan.runArtifactRecordIds);
    delIn(hubDb, "ArtifactFileContainer", "Id", plan.runArtifactContainerIds);
    delIn(hubDb, "Artifacts", "AttemptId", plan.attemptIds);
    // Artifact rows pruned on their own (run kept): only the specific records-bearing artifacts.
    delIn(hubDb, "ArtifactRecords", "Id", plan.onlyArtifactRecordIds);
    delIn(hubDb, "ArtifactFileContainer", "Id", plan.onlyArtifactContainerIds);
    delIn(hubDb, "Artifacts", "Id", plan.onlyArtifactIds);
    delIn(hubDb, "Jobs", "JobId", plan.jobIds);
    delIn(hubDb, "WorkflowRunAttempt", "Id", plan.attemptIds);
    delIn(hubDb, "WorkflowRun", "Id", plan.runIds);
    hubDb.exec("COMMIT");
  } catch (e) {
    hubDb.exec("ROLLBACK");
    throw e;
  }

  // 2. joblogs rows for the pruned runs (separate DB → separate transaction).
  const jlIds = [...new Set(plan.joblogsTimelineIds)];
  if (joblogsDb && jlIds.length) {
    joblogsDb.exec("BEGIN");
    try {
      delIn(joblogsDb, "job_logs", "timeline_id", jlIds);
      delIn(joblogsDb, "streams", "timeline_id", jlIds);
      joblogsDb.exec("COMMIT");
    } catch (e) {
      joblogsDb.exec("ROLLBACK");
      throw e;
    }
  }

  // 3. Unlink files only after the rows referencing them are gone.
  let freedArtifactBytes = 0;
  for (const b of plan.blobs) {
    const n = bytesOf(b.path);
    try {
      unlink(b.path);
      freedArtifactBytes += n;
    } catch {
      /* already gone / unwritable — the row is deleted, so no orphan; just leaked bytes */
    }
  }
  let freedMirrorBytes = 0;
  for (const f of plan.mirrorFiles) {
    const n = bytesOf(f.path);
    try {
      unlink(f.path);
      freedMirrorBytes += n;
    } catch {
      /* ignore */
    }
  }
  pruneEmptyDirs(mirrorDir());

  // 4. Compact hub.db so the freed rows actually return disk (best effort — VACUUM needs an
  //    exclusive lock, which a live hub may hold; then we simply skip it and report null).
  let hubDbFreedBytes: number | null = null;
  if (plan.runIds.length) {
    try {
      hubDb.exec("VACUUM");
      // VACUUM's shrink only reaches the main file once the WAL is checkpointed; truncate it so the
      // measured after-size is final while our connection is still open.
      try {
        hubDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        /* not in WAL mode / no checkpoint needed */
      }
      hubDbFreedBytes = Math.max(0, hubBytesBefore - hubBytes());
    } catch {
      hubDbFreedBytes = null;
    }
  }

  return { counts: plan.report, freedArtifactBytes, freedMirrorBytes, hubDbFreedBytes };
}

// ── cli ─────────────────────────────────────────────────────────────────────
/** Human byte size (1024-based), matching common `du -h` style. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export interface PruneCliOpts {
  olderThan?: string;
  keepLast?: string;
  runs?: boolean;
  mirror?: boolean;
  artifacts?: boolean;
  dryRun?: boolean;
}

export interface PruneCmdDeps {
  now?: number;
  openHub?: (path: string, readOnly: boolean) => Promise<Db>;
  openJoblogs?: (path: string, readOnly: boolean) => Promise<Db>;
  print?: (line: string) => void;
}

/**
 * `ndh hub prune` — trim hub run records, artifact blobs, and the mirror cache on an age / keep-last
 * policy. Runs locally against this machine's NDH_HOME (like the joblogs auto-prune), so it must be
 * run where the hub's files live. It is safe to run while the hub is up: only completed runs are
 * touched. `--dry-run` reports exactly what a real run would remove without deleting anything.
 */
export async function pruneCmd(opts: PruneCliOpts, deps: PruneCmdDeps = {}): Promise<number> {
  const now = deps.now ?? Date.now();
  const out = deps.print ?? ((l: string) => console.log(l));

  // Retention knobs (at least one required, or we would delete every completed run).
  let olderThanDays: number | undefined;
  if (opts.olderThan !== undefined) {
    olderThanDays = Number(opts.olderThan);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      log(`invalid --older-than '${opts.olderThan}' — expected a number of days`);
      return 2;
    }
  }
  let keepLast: number | undefined;
  if (opts.keepLast !== undefined) {
    keepLast = Number(opts.keepLast);
    if (!Number.isInteger(keepLast) || keepLast < 0) {
      log(`invalid --keep-last '${opts.keepLast}' — expected a non-negative integer`);
      return 2;
    }
  }
  if (olderThanDays === undefined && keepLast === undefined) {
    log("nothing to do — specify a retention policy with --older-than <days> and/or --keep-last <N>");
    return 2;
  }

  // Category selectors default to all when none is passed.
  const anySelector = Boolean(opts.runs || opts.mirror || opts.artifacts);
  const wantRuns = anySelector ? Boolean(opts.runs) : true;
  const wantMirror = anySelector ? Boolean(opts.mirror) : true;
  const wantArtifacts = anySelector ? Boolean(opts.artifacts) : true;

  const dbPath = hubDbPath();
  if (!existsSync(dbPath)) {
    log(`no hub database at ${dbPath} — run 'ndh hub prune' on the hub machine`);
    return 1;
  }

  const openHub = deps.openHub ?? openHubDb;
  const openJoblogs = deps.openJoblogs ?? openHubDb;
  const hubDb = await openHub(dbPath, Boolean(opts.dryRun));

  try {
    const plan = buildPlan(hubDb, {
      olderThanDays,
      keepLast,
      now,
      runs: wantRuns,
      mirror: wantMirror,
      artifacts: wantArtifacts,
    });
    const r = plan.report;

    out(`prune ${opts.dryRun ? "plan (dry-run — nothing deleted)" : "results"}:`);
    if (wantRuns) {
      out(
        `  runs:      ${r.runs} run${r.runs === 1 ? "" : "s"} ` +
          `(${r.attempts} attempts, ${r.jobs} jobs, ${r.timelineRecords} timeline records, ${r.logs} logs), ` +
          `${r.joblogsTimelines} joblog timelines`,
      );
    }
    if (wantArtifacts) out(`  artifacts: ${r.artifactBlobs} blobs, ${formatBytes(r.artifactBytes)}`);
    if (wantMirror) out(`  mirror:    ${r.mirrorFiles} files, ${formatBytes(r.mirrorBytes)}`);

    if (opts.dryRun) {
      out("re-run without --dry-run to delete.");
      return 0;
    }

    if (!r.runs && !r.artifactBlobs && !r.mirrorFiles) {
      out("nothing matched the retention policy.");
      return 0;
    }

    const jlPath = joblogsDbPath();
    const joblogsDb = plan.joblogsTimelineIds.length && existsSync(jlPath) ? await openJoblogs(jlPath, false) : null;
    try {
      const res = executePlan(hubDb, joblogsDb, plan);
      out(
        `freed: ${formatBytes(res.freedArtifactBytes)} artifacts, ${formatBytes(res.freedMirrorBytes)} mirror` +
          (res.hubDbFreedBytes != null
            ? `, ${formatBytes(res.hubDbFreedBytes)} reclaimed in hub.db`
            : r.runs
              ? ", hub.db not compacted (stop the hub and re-run to reclaim its space)"
              : ""),
      );
    } finally {
      joblogsDb?.close();
    }
    return 0;
  } finally {
    hubDb.close();
  }
}

/** Register `ndh hub prune` on the given `hub` command. */
export function registerPrune(hub: Command): void {
  hub
    .command("prune")
    .description("trim old run records, artifact blobs, and the mirror cache (bounded retention)")
    .option("--older-than <days>", "remove items older than this many days")
    .option("--keep-last <N>", "always keep the N most recent runs per project (and N newest mirror files)")
    .option("--runs", "prune run records (+ their timelines, logs, artifacts, joblogs)")
    .option("--mirror", "prune the action mirror cache")
    .option("--artifacts", "prune artifact blobs (of pruned/old runs + orphaned files)")
    .option("--dry-run", "report what would be deleted, delete nothing")
    .addHelpText(
      "after",
      "\nwith no --runs/--mirror/--artifacts selector, all three are pruned. Requires --older-than and/or --keep-last.\nRuns locally on the hub machine; safe to run while the hub is up (only completed runs are removed).",
    )
    .action(async (opts: PruneCliOpts) => {
      process.exitCode = await pruneCmd(opts);
    });
}

/** Best-effort removal of now-empty directories under `root` (leaves root itself). */
export function pruneEmptyDirs(root: string): void {
  const walk = (d: string): boolean => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const e of entries) {
      if (e.isDirectory()) {
        const childEmpty = walk(join(d, e.name));
        if (childEmpty) {
          try {
            rmdirSync(join(d, e.name));
          } catch {
            empty = false;
          }
        } else empty = false;
      } else empty = false;
    }
    return empty;
  };
  walk(root);
}
