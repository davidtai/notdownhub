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
 * ordered lines for a job's timeline. Retention deletes timelines older than 14 days
 * (matching the file-log default).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any; // node:sqlite DatabaseSync — typed loosely; the module is experimental.

export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function joblogsDbPath(): string {
  return join(ndhHome(), "hub", "joblogs.db");
}


/** Open (and, when writable, initialize) the joblogs database. */
export async function openDb(path: string, readOnly = false): Promise<Db> {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { readOnly });
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
 * GET /api/local/joblogs/<runId>/<timelineId> → { retained, lines }. `retained` is
 * false when nothing was stored (a run predating this feature, or an unknown job),
 * so the UI can show a calm "not retained" note instead of an empty pane.
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
  const lines = await readJobLog(joblogsDbPath(), timelineId, Number.isInteger(runIdNum) ? runIdNum : undefined);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ retained: !!(lines && lines.length), lines: lines ?? [] }));
}

// ── run_id resolution (best effort, read-only) ──────────────────────────────
/** Look up the run a timeline belongs to, from the hub's own DB. Never throws. */
export function makeRunIdResolver(hubDb: Db | null): (timelineId: string) => number | null {
  const cache = new Map<string, number>();
  return (timelineId: string): number | null => {
    const hit = cache.get(timelineId);
    if (hit !== undefined) return hit;
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
      try {
        hubDb = await openDb(opts.hubDbPath ?? hubDbPath(), true);
      } catch {
        hubDb = null;
      }
      resolve1 = makeRunIdResolver(hubDb);
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
