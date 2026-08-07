import http from "node:http";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerResponse } from "node:http";
import { ndhHome, hubDbPath } from "./lib.js";

/**
 * Persistent job console logs. The hub keeps step console output only in memory and
 * drops it once a run finishes, so a completed run's logs vanish on restart. This
 * module tees the hub's live console feed into a SQLite database we own
 * (NDH_HOME/hub/joblogs.db, WAL) so a run stays fully restorable: metadata from the
 * hub's own DB + console output from ours. We never write the hub's database.
 *
 * Flow: a long-lived reader consumes the hub's global TimeLineWebConsoleLog SSE feed,
 * batches lines, and commits them per flush interval. Retrieval reconstructs the
 * ordered lines for a job's timeline and enforces the run/timeline pairing (a wrong
 * run id 404s, issue #81). Retention deletes timelines older than 14 days
 * (matching the file-log default).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any; // node:sqlite DatabaseSync — typed loosely; the module is experimental.

export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Path to the joblogs database for the current NDH_HOME. Exposed so the run-control paths use the same file. */
export function joblogsDbPath(): string {
  return join(ndhHome(), "hub", "joblogs.db");
}


/** Open (and, when writable, initialize) the joblogs database. */
export async function openDb(path: string, readOnly = false): Promise<Db> {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { readOnly });
  // A short busy timeout lets an occasional writer (the tee + a run-delete) coexist without
  // an immediate SQLITE_BUSY; both live in the hub process, so contention is rare and brief.
  db.exec("PRAGMA busy_timeout=2000");
  if (!readOnly) {
    // WAL lets the retrieval endpoint read while the tee writes, and survives a hard kill.
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(
      `CREATE TABLE IF NOT EXISTS job_logs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         run_id INTEGER,
         timeline_id TEXT NOT NULL,
         record_id TEXT,
         ts INTEGER NOT NULL,
         line TEXT NOT NULL
       )`,
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_job_logs_tl ON job_logs(timeline_id, id)");
    db.exec(
      `CREATE TABLE IF NOT EXISTS streams (
         timeline_id TEXT PRIMARY KEY,
         run_id INTEGER,
         updated_at INTEGER NOT NULL
       )`,
    );
    // Tombstones for truly-deleted runs. The engine (Runner.Server) exposes no run-deletion
    // endpoint and we never write its database, so a deleted run is recorded here — the DB we
    // own — and the front enforces it (filtered from the runs list, 404 on detail). Because this
    // table is persisted, a deleted run stays gone across hub restarts (the old "hidden runs come
    // back" bug). Retention prune leaves it alone: a tombstone is tiny and must outlive the logs.
    db.exec(
      `CREATE TABLE IF NOT EXISTS deleted_runs (
         run_id INTEGER PRIMARY KEY,
         deleted_at INTEGER NOT NULL
       )`,
    );
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
  }
  return db;
}

// ── SSE frame parser ────────────────────────────────────────────────────────
export interface SseEvent {
  event: string;
  data: string;
}

/** Stateful parser: feed it raw chunks, it calls back once per complete SSE frame. */
export function createSseParser(onEvent: (ev: SseEvent) => void): (chunk: string) => void {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) onEvent({ event, data: data.join("\n") });
    }
  };
}

// eslint-disable-next-line no-control-regex
// Strip all CSI escape sequences (require the ESC so literal "[0m" in log text survives,
// and match any final byte so cursor/erase sequences don't leave raw escape bytes behind).
const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Remove ANSI CSI escape sequences from a log line (the tee stores plain text; `ndh watch` reuses this). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export interface PendingLine {
  runId: number | null;
  timelineId: string;
  recordId: string | null;
  ts: number;
  line: string;
}

/** Batches log lines and commits them in a single transaction per flush. */
export class JobLogWriter {
  private pending: PendingLine[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Db,
    private flushMs = 250,
    private maxBatch = 500,
  ) {}

  add(rows: PendingLine[]): void {
    if (!rows.length) return;
    this.pending.push(...rows);
    if (this.pending.length >= this.maxBatch) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending.length) return;
    const rows = this.pending;
    this.pending = [];
    const ins = this.db.prepare("INSERT INTO job_logs(run_id,timeline_id,record_id,ts,line) VALUES(?,?,?,?,?)");
    const touch = this.db.prepare(
      `INSERT INTO streams(timeline_id,run_id,updated_at) VALUES(?,?,?)
       ON CONFLICT(timeline_id) DO UPDATE SET updated_at=excluded.updated_at,
         run_id=COALESCE(streams.run_id, excluded.run_id)`,
    );
    this.db.exec("BEGIN");
    try {
      const touched = new Set<string>();
      for (const r of rows) {
        ins.run(r.runId, r.timelineId, r.recordId, r.ts, r.line);
        if (!touched.has(r.timelineId)) {
          touch.run(r.timelineId, r.runId, r.ts);
          touched.add(r.timelineId);
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  stop(): void {
    this.flush();
  }
}

/** Delete every timeline whose last update is older than the cutoff. Returns rows removed. */
export function pruneOldRuns(db: Db, cutoffMs: number): number {
  db.exec("BEGIN");
  try {
    const del = db.prepare("DELETE FROM job_logs WHERE timeline_id IN (SELECT timeline_id FROM streams WHERE updated_at < ?)");
    const info = del.run(cutoffMs);
    db.prepare("DELETE FROM streams WHERE updated_at < ?").run(cutoffMs);
    db.exec("COMMIT");
    return Number(info.changes ?? 0);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ── true delete (tombstone + log purge) ──────────────────────────────────────
/**
 * Purge every persisted log row for a run. The tee often can't resolve a run_id at write time
 * (it arrives before the Jobs row exists), so most rows are keyed only by timeline_id with a NULL
 * run_id. We therefore purge by run_id AND by the run's timeline ids (resolved from the hub DB),
 * plus the matching streams rows. One statement each; returns the number of job_logs rows removed.
 */
export function purgeRunLogs(db: Db, runId: number, timelineIds: string[] = []): number {
  const tl = [...new Set(timelineIds.filter(Boolean))];
  const inLogs = tl.length ? ` OR timeline_id IN (${tl.map(() => "?").join(",")})` : "";
  const info = db.prepare(`DELETE FROM job_logs WHERE run_id = ?${inLogs}`).run(runId, ...tl);
  db.prepare(`DELETE FROM streams WHERE run_id = ?${inLogs}`).run(runId, ...tl);
  return Number(info.changes ?? 0);
}

/**
 * Truly delete a run from the hub's point of view: purge its persisted logs and record a
 * tombstone so the front treats it as gone everywhere (list, detail, logs) forever — including
 * after a restart. Returns how many log rows were purged. One transaction: either both land or
 * neither does, so a run is never left half-deleted.
 */
export function markRunDeleted(db: Db, runId: number, timelineIds: string[] = [], now = Date.now): number {
  db.exec("BEGIN");
  try {
    const purged = purgeRunLogs(db, runId, timelineIds);
    db.prepare("INSERT OR REPLACE INTO deleted_runs(run_id, deleted_at) VALUES(?, ?)").run(runId, now());
    db.exec("COMMIT");
    return purged;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * The timeline ids belonging to a run, from the hub's own DB (read-only, tolerant). Jobs.TimeLineId
 * is stored upper-cased while the console feed (and thus our job_logs/streams) is lower-case, so we
 * normalize to lower-case to match. Returns [] if the DB or table can't be read.
 */
export async function resolveRunTimelines(hubDb: string, runId: number): Promise<string[]> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(hubDb, { readOnly: true });
    try {
      const rows = db.prepare("SELECT TimeLineId AS tl FROM Jobs WHERE runid = ?").all(runId) as { tl: string | null }[];
      return rows.map((r) => r.tl).filter((t): t is string => !!t).map((t) => t.toLowerCase());
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Open the joblogs DB writable, resolve the run's timelines from the hub DB, then tombstone +
 * purge the run and close. Returns rows purged.
 */
export async function deleteRun(
  dbPath: string,
  runId: number,
  opts: { hubDbPath?: string } = {},
): Promise<{ logsPurged: number }> {
  const timelineIds = await resolveRunTimelines(opts.hubDbPath ?? hubDbPath(), runId);
  const db = await openDb(dbPath);
  try {
    return { logsPurged: markRunDeleted(db, runId, timelineIds) };
  } finally {
    db.close();
  }
}

/**
 * The set of tombstoned run ids, read-only. Returns an empty set if the DB (or the table, on a
 * pre-feature database) can't be read — deletion is additive, so an unreadable tombstone store
 * simply means "nothing is deleted" rather than an error the front has to handle.
 */
export async function readDeletedRunIds(dbPath: string): Promise<Set<number>> {
  try {
    const db = await openDb(dbPath, true);
    try {
      const rows = db.prepare("SELECT run_id FROM deleted_runs").all() as { run_id: number }[];
      return new Set(rows.map((r) => r.run_id));
    } finally {
      db.close();
    }
  } catch {
    return new Set();
  }
}

/** Whether a single run has been tombstoned (read-only; false on any read failure). */
export async function isRunDeleted(dbPath: string, runId: number): Promise<boolean> {
  return (await readDeletedRunIds(dbPath)).has(runId);
}

/**
 * Ordered console lines for a job's timeline, or null if the DB can't be read.
 * When runId is given, the timeline must belong to that run (or have an unresolved/null
 * run_id) — this validates the /joblogs/<runId>/<timelineId> pairing instead of ignoring runId.
 */
export async function readJobLog(dbPath: string, timelineId: string, runId?: number): Promise<string[] | null> {
  try {
    const db = await openDb(dbPath, true);
    try {
      const sql =
        runId !== undefined
          ? "SELECT j.line FROM job_logs j LEFT JOIN streams s ON s.timeline_id = j.timeline_id " +
            "WHERE j.timeline_id=? AND (s.run_id=? OR s.run_id IS NULL) ORDER BY j.id"
          : "SELECT line FROM job_logs WHERE timeline_id=? ORDER BY id";
      const rows = (runId !== undefined
        ? db.prepare(sql).all(timelineId, runId)
        : db.prepare(sql).all(timelineId)) as { line: string }[];
      return rows.map((r) => r.line);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * The run a stored timeline belongs to, from our streams table. Returns null when the
 * pairing is unknown: no row for the timeline, an unresolved (NULL) run_id, or an
 * unreadable database. Never throws.
 */
export async function storedRunId(dbPath: string, timelineId: string): Promise<number | null> {
  try {
    const db = await openDb(dbPath, true);
    try {
      const row = db.prepare("SELECT run_id AS r FROM streams WHERE timeline_id=?").get(timelineId) as
        | { r: number | null }
        | undefined;
      return typeof row?.r === "number" ? row.r : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * GET /api/local/joblogs/<runId>/<timelineId> → { retained, lines }. `retained` is
 * false when nothing was stored (a run predating this feature, or an unknown job),
 * so the UI can show a calm "not retained" note instead of an empty pane. A timeline
 * whose stored run_id contradicts the requested runId 404s (issue #81): the pairing
 * is enforced, not decorative. An unresolved (NULL) run_id stays tolerant.
 */
export async function serveJobLogs(pathname: string, res: ServerResponse): Promise<void> {
  const m = pathname.match(/^\/api\/local\/joblogs\/([^/]+)\/([^/]+)\/?$/);
  if (!m) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "expected /api/local/joblogs/<runId>/<timelineId>" }));
    return;
  }
  const runIdNum = Number(decodeURIComponent(m[1]));
  const timelineId = decodeURIComponent(m[2]);
  const runId = Number.isInteger(runIdNum) ? runIdNum : undefined;
  if (runId !== undefined) {
    const owner = await storedRunId(joblogsDbPath(), timelineId);
    if (owner !== null && owner !== runId) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "timeline does not belong to this run", runId, timelineId }));
      return;
    }
  }
  const lines = await readJobLog(joblogsDbPath(), timelineId, runId);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ retained: !!(lines && lines.length), lines: lines ?? [] }));
}

// ── run_id resolution (best effort, read-only) ──────────────────────────────
/**
 * Look up the run a timeline belongs to, from the hub's own DB. Never throws.
 * Accepts a handle or a provider function: the tee's hub-DB handle is opened lazily
 * (the file may not exist yet at startup — issue #81), so the resolver must always
 * read the CURRENT handle, not the one captured at construction.
 */
export function makeRunIdResolver(hubDbOrGet: Db | null | (() => Db | null)): (timelineId: string) => number | null {
  const get: () => Db | null = typeof hubDbOrGet === "function" ? (hubDbOrGet as () => Db | null) : () => hubDbOrGet;
  const cache = new Map<string, number>();
  return (timelineId: string): number | null => {
    const hit = cache.get(timelineId);
    if (hit !== undefined) return hit;
    const hubDb = get();
    if (!hubDb) return null;
    try {
      // Jobs.TimeLineId is stored upper-cased while the console feed emits lower-case.
      const row = hubDb
        .prepare("SELECT runid AS runid FROM Jobs WHERE TimeLineId = ? COLLATE NOCASE LIMIT 1")
        .get(timelineId) as { runid?: number } | undefined;
      const runId = row?.runid;
      // Only cache a real hit — early log lines can arrive before the Jobs row exists.
      if (typeof runId === "number") {
        cache.set(timelineId, runId);
        return runId;
      }
    } catch {
      /* ignore */
    }
    return null;
  };
}

// ── the tee ─────────────────────────────────────────────────────────────────
export interface TeeOptions {
  dbPath?: string;
  hubDbPath?: string;
  baseUrl?: string;
  flushMs?: number;
  retentionMs?: number;
  reconnectMs?: number;
  now?: () => number;
  /** test hook: notified after the writer commits a batch */
  onFlush?: () => void;
}

export interface JobLogTee {
  stop: () => void;
  /** resolves once the DB is open and the first connection attempt is made (tests) */
  ready: Promise<void>;
}

/**
 * Start teeing the hub's console feed to disk. Returns immediately; connection and
 * DB setup happen asynchronously and any failure disables the tee silently (the UI
 * simply shows no retained logs). Call stop() to release the reader, timers, and DB.
 */
export function startJobLogTee(hubPort: number, opts: TeeOptions = {}): JobLogTee {
  const dbPath = opts.dbPath ?? joblogsDbPath();
  const base = opts.baseUrl ?? `http://127.0.0.1:${hubPort}`;
  const now = opts.now ?? Date.now;
  let db: Db | null = null;
  let hubDb: Db | null = null;
  let writer: JobLogWriter | null = null;
  let resolve1: (id: string) => number | null = () => null;
  let stopped = false;
  let currentReq: http.ClientRequest | null = null;
  let pruneTimer: NodeJS.Timeout | null = null;

  // The hub creates its DB after we start (fresh NDH_HOME), so a one-shot open at
  // startup left run_id unresolved forever (issue #81). Open lazily and keep retrying.
  const ensureHubDb = async (): Promise<Db | null> => {
    if (!hubDb) {
      try {
        hubDb = await openDb(opts.hubDbPath ?? hubDbPath(), true);
      } catch {
        hubDb = null;
      }
    }
    return hubDb;
  };

  const connect = () => {
    if (stopped) return;
    const parse = createSseParser((ev) => {
      if (ev.event !== "log") return;
      try {
        const d = JSON.parse(ev.data) as {
          timelineId?: string;
          recordId?: string;
          record?: { value?: string[]; stepId?: string };
        };
        const value = d.record?.value;
        if (!d.timelineId || !value?.length) return;
        const runId = resolve1(d.timelineId);
        const recordId = d.recordId ?? d.record?.stepId ?? null;
        const ts = now();
        writer?.add(
          value.map((line) => ({ runId, timelineId: d.timelineId!, recordId, ts, line: line.replace(ANSI, "") })),
        );
        if (opts.onFlush) {
          writer?.flush();
          opts.onFlush();
        }
      } catch {
        /* skip malformed frame */
      }
    });
    const req = http.get(`${base}/_apis/v1/TimeLineWebConsoleLog`, (r) => {
      r.setEncoding("utf8");
      r.on("data", (c: string) => parse(c));
      r.on("end", scheduleReconnect);
      r.on("error", scheduleReconnect);
    });
    currentReq = req;
    req.on("error", scheduleReconnect);
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const t = setTimeout(connect, opts.reconnectMs ?? 2000);
    t.unref?.();
  };

  const ready = (async () => {
    try {
      db = await openDb(dbPath);
      writer = new JobLogWriter(db, opts.flushMs ?? 250);
      await ensureHubDb();
      // The resolver reads the CURRENT handle: hub.db often appears after startup.
      resolve1 = makeRunIdResolver(() => hubDb);
      const prune = () => {
        try {
          pruneOldRuns(db, now() - (opts.retentionMs ?? RETENTION_MS));
        } catch {
          /* ignore */
        }
      };
      prune();
      pruneTimer = setInterval(prune, 60 * 60 * 1000);
      pruneTimer.unref?.();
      connect();
    } catch {
      /* tee disabled */
    }
  })();

  const stop = () => {
    stopped = true;
    currentReq?.destroy();
    if (pruneTimer) clearInterval(pruneTimer);
    try {
      writer?.stop();
    } catch {
      /* ignore */
    }
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    try {
      hubDb?.close();
    } catch {
      /* ignore */
    }
  };

  return { stop, ready };
}
