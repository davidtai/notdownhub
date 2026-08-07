import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  RETENTION_MS,
  openDb,
  createSseParser,
  JobLogWriter,
  pruneOldRuns,
  readJobLog,
  serveJobLogs,
  makeRunIdResolver,
  startJobLogTee,
  type SseEvent,
} from "../joblogs.js";
import { freshHome, startServer, type Fixture } from "./helpers.js";

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), "ndh-jl-")), "joblogs.db");
}

function logFrame(timelineId: string, value: string[], recordId = "r1"): string {
  return `event: log\ndata: ${JSON.stringify({ timelineId, recordId, record: { value, stepId: recordId } })}\n\n`;
}

// ── SSE parser ───────────────────────────────────────────────────────────────
test("createSseParser: assembles frames split across chunks; strips one leading data space; ignores dataless frames", () => {
  const events: SseEvent[] = [];
  const feed = createSseParser((e) => events.push(e));
  feed("event: log\nda");
  feed("ta: hello\n\n");
  feed(": just a comment\n\n"); // no data -> ignored
  feed("event: timeline\ndata: a\ndata: b\n\n"); // multi-line data joined
  assert.deepEqual(events, [
    { event: "log", data: "hello" },
    { event: "timeline", data: "a\nb" },
  ]);
});

// ── openDb ───────────────────────────────────────────────────────────────────
test("openDb: creates schema in WAL mode (write); read-only opens without schema writes", async () => {
  const path = tmp();
  const db = await openDb(path);
  const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(String(mode.journal_mode).toLowerCase(), "wal");
  const cols = db.prepare("PRAGMA table_info(job_logs)").all() as { name: string }[];
  assert.ok(cols.some((c) => c.name === "timeline_id"));
  db.close();
  const ro = await openDb(path, true);
  assert.equal((ro.prepare("SELECT COUNT(*) n FROM job_logs").get() as { n: number }).n, 0);
  ro.close();
});

// ── writer + read ────────────────────────────────────────────────────────────
test("JobLogWriter: flushes on size threshold, preserves order, upserts stream metadata", async () => {
  const path = tmp();
  const db = await openDb(path);
  // maxBatch 3 forces an immediate flush without waiting on the timer
  const w = new JobLogWriter(db, 10_000, 3);
  w.add([
    { runId: 5, timelineId: "tl", recordId: "a", ts: 100, line: "one" },
    { runId: 5, timelineId: "tl", recordId: "a", ts: 100, line: "two" },
    { runId: 5, timelineId: "tl", recordId: "a", ts: 100, line: "three" },
  ]);
  const rows = db.prepare("SELECT line FROM job_logs ORDER BY id").all() as { line: string }[];
  assert.deepEqual(rows.map((r) => r.line), ["one", "two", "three"]);
  const stream = db.prepare("SELECT run_id, updated_at FROM streams WHERE timeline_id='tl'").get() as {
    run_id: number;
    updated_at: number;
  };
  assert.equal(stream.run_id, 5);
  // a later batch with null run_id must not clobber the resolved run_id (COALESCE)
  w.add([{ runId: null, timelineId: "tl", recordId: "a", ts: 200, line: "four" }]);
  w.flush();
  assert.equal((db.prepare("SELECT run_id FROM streams WHERE timeline_id='tl'").get() as { run_id: number }).run_id, 5);
  assert.equal((await readJobLog(path, "tl"))!.length, 4);
  // run_id-scoped retrieval: matching run returns the lines; a wrong run returns none;
  // a stream with a null/unresolved run_id is still returned (tolerant match).
  assert.equal((await readJobLog(path, "tl", 5))!.length, 4, "matching run_id returns the lines");
  assert.equal((await readJobLog(path, "tl", 999))!.length, 0, "a non-matching run_id returns nothing");
  w.add([{ runId: null, timelineId: "tlnull", recordId: null, ts: 1, line: "x" }]);
  w.flush();
  assert.equal((await readJobLog(path, "tlnull", 7))!.length, 1, "unresolved (null) run_id is tolerated");
  w.add([]); // no-op
  w.flush(); // empty flush is a no-op
  db.close();
});

test("JobLogWriter: timer-based flush persists without an explicit flush()", async () => {
  const path = tmp();
  const db = await openDb(path);
  const w = new JobLogWriter(db, 15, 999);
  w.add([{ runId: null, timelineId: "tl", recordId: null, ts: 1, line: "later" }]);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(await readJobLog(path, "tl"), ["later"]);
  db.close();
});

test("readJobLog: returns null when the database does not exist", async () => {
  assert.equal(await readJobLog(join(tmpdir(), "does-not-exist-xyz", "j.db"), "tl"), null);
});

// ── prune ────────────────────────────────────────────────────────────────────
test("pruneOldRuns: deletes timelines older than the cutoff, keeps recent ones", async () => {
  const path = tmp();
  const db = await openDb(path);
  const w = new JobLogWriter(db, 10_000, 1);
  w.add([{ runId: 1, timelineId: "old", recordId: null, ts: 1000, line: "ancient" }]);
  w.add([{ runId: 2, timelineId: "new", recordId: null, ts: 9000, line: "fresh" }]);
  const removed = pruneOldRuns(db, 5000); // cutoff between the two
  assert.equal(removed, 1);
  assert.equal(await (await readJobLog(path, "old"))!.length, 0);
  assert.deepEqual(await readJobLog(path, "new"), ["fresh"]);
  db.close();
});

test("JobLogWriter.flush: rolls back and rethrows when the insert fails", async () => {
  const path = tmp();
  const db = await openDb(path);
  db.exec("DROP TABLE job_logs"); // make the INSERT fail inside the transaction
  const w = new JobLogWriter(db, 10_000, 1);
  assert.throws(() => w.add([{ runId: 1, timelineId: "t", recordId: null, ts: 1, line: "x" }]));
  db.close();
});

test("pruneOldRuns: rolls back and rethrows on a query error", async () => {
  const path = tmp();
  const db = await openDb(path);
  db.exec("DROP TABLE streams");
  assert.throws(() => pruneOldRuns(db, 1));
  db.close();
});

// ── serveJobLogs ─────────────────────────────────────────────────────────────
interface Cap {
  code?: number;
  headers?: Record<string, string>;
  body?: string;
}
function capRes(): { res: http.ServerResponse; rec: Cap } {
  const rec: Cap = {};
  const res = {
    writeHead(code: number, headers?: Record<string, string>) {
      rec.code = code;
      rec.headers = headers;
    },
    end(b?: string) {
      rec.body = b;
    },
  } as never as http.ServerResponse;
  return { res, rec };
}

test("serveJobLogs: 404 on a malformed path", async () => {
  freshHome();
  const c = capRes();
  await serveJobLogs("/api/local/joblogs/only-one-part", c.res);
  assert.equal(c.rec.code, 404);
});

test("serveJobLogs: retained=false when nothing is stored for the timeline", async () => {
  freshHome(); // no joblogs.db in this home
  const c = capRes();
  await serveJobLogs("/api/local/joblogs/7/some-timeline", c.res);
  assert.equal(c.rec.code, 200);
  assert.deepEqual(JSON.parse(c.rec.body!), { retained: false, lines: [] });
});

test("serveJobLogs: retained=true with ordered lines when persisted", async () => {
  const home = freshHome();
  const db = await openDb(join(home, "hub", "joblogs.db"));
  new JobLogWriter(db, 10_000, 2).add([
    { runId: 7, timelineId: "tl-x", recordId: null, ts: 1, line: "##[group]Run build" },
    { runId: 7, timelineId: "tl-x", recordId: null, ts: 1, line: "built ok" },
  ]);
  db.close();
  const c = capRes();
  await serveJobLogs("/api/local/joblogs/7/tl-x", c.res);
  const j = JSON.parse(c.rec.body!);
  assert.equal(j.retained, true);
  assert.deepEqual(j.lines, ["##[group]Run build", "built ok"]);
});

// ── run_id resolver ──────────────────────────────────────────────────────────
test("makeRunIdResolver: case-insensitive hit, null miss, caches, tolerates a null db", async () => {
  const hubPath = tmp();
  const hub = new DatabaseSync(hubPath);
  hub.exec("CREATE TABLE Jobs(JobId TEXT, TimeLineId TEXT, runid INTEGER)");
  hub.prepare("INSERT INTO Jobs(TimeLineId,runid) VALUES(?,?)").run("ABCDEF-UPPER", 42);
  const resolve = makeRunIdResolver(hub);
  assert.equal(resolve("abcdef-upper"), 42); // COLLATE NOCASE
  assert.equal(resolve("abcdef-upper"), 42); // cached
  assert.equal(resolve("unknown-tl"), null);
  hub.close();
  assert.equal(makeRunIdResolver(null)("anything"), null);
});

// ── the tee (end to end) ─────────────────────────────────────────────────────
async function sseHub(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Fixture & { conns: () => number }> {
  let conns = 0;
  const fx = await startServer((req, res) => {
    if (!(req.url ?? "").includes("TimeLineWebConsoleLog")) {
      res.writeHead(404);
      res.end();
      return;
    }
    conns++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    handler(req, res);
  });
  return { ...fx, conns: () => conns };
}

test("startJobLogTee: persists log events from the feed, resolving run_id from the hub DB", async () => {
  const dbPath = tmp();
  const hubPath = tmp();
  const hub = new DatabaseSync(hubPath);
  hub.exec("CREATE TABLE Jobs(JobId TEXT, TimeLineId TEXT, runid INTEGER)");
  hub.prepare("INSERT INTO Jobs(TimeLineId,runid) VALUES(?,?)").run("JOBTL", 99);
  hub.close();

  const feed = await sseHub((_req, res) => {
    res.write(logFrame("jobtl", ["\x1b[32mgreen\x1b[0m line", "second"])); // ANSI stripped
    res.write(logFrame("jobtl", ["third"]));
    res.write("event: timeline\ndata: {\"ignored\":true}\n\n"); // non-log ignored
    res.write("event: log\ndata: not-json\n\n"); // malformed -> skipped
  });

  const tee = startJobLogTee(0, { dbPath, hubDbPath: hubPath, baseUrl: feed.url, flushMs: 5, reconnectMs: 50 });
  await tee.ready;
  await new Promise((r) => setTimeout(r, 120));
  const lines = await readJobLog(dbPath, "jobtl");
  assert.deepEqual(lines, ["green line", "second", "third"]);
  // run_id resolved case-insensitively (feed 'jobtl' vs Jobs 'JOBTL')
  const chk = await openDb(dbPath, true);
  assert.equal((chk.prepare("SELECT run_id FROM streams WHERE timeline_id='jobtl'").get() as { run_id: number }).run_id, 99);
  chk.close();
  tee.stop();
  await feed.close();
});

test("startJobLogTee: reconnects after the feed drops", async () => {
  const dbPath = tmp();
  const feed = await sseHub((_req, res) => {
    res.end(); // close immediately -> tee should reconnect
  });
  const tee = startJobLogTee(0, { dbPath, hubDbPath: tmp(), baseUrl: feed.url, flushMs: 5, reconnectMs: 20 });
  await tee.ready;
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(feed.conns() >= 2, `expected reconnects, got ${feed.conns()}`);
  tee.stop();
  await feed.close();
});

test("startJobLogTee: prunes stale rows on start using retentionMs + now", async () => {
  const dbPath = tmp();
  // seed an old row directly
  const seed = await openDb(dbPath);
  new JobLogWriter(seed, 10_000, 1).add([{ runId: 1, timelineId: "stale", recordId: null, ts: 0, line: "old" }]);
  seed.close();
  const feed = await sseHub((_req, res) => {
    /* keep open, emit nothing */
  });
  const tee = startJobLogTee(0, {
    dbPath,
    hubDbPath: tmp(),
    baseUrl: feed.url,
    now: () => 1_000_000_000,
    retentionMs: 1000, // cutoff far after ts=0 -> stale removed
    flushMs: 5,
  });
  await tee.ready;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await readJobLog(dbPath, "stale"))!.length, 0);
  tee.stop();
  await feed.close();
});

test("startJobLogTee: onFlush hook fires and stop() is idempotent", async () => {
  const dbPath = tmp();
  let flushes = 0;
  const feed = await sseHub((_req, res) => {
    res.write(logFrame("t", ["x"]));
  });
  const tee = startJobLogTee(0, { dbPath, hubDbPath: tmp(), baseUrl: feed.url, onFlush: () => flushes++, flushMs: 5, reconnectMs: 40 });
  await tee.ready;
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(flushes >= 1);
  tee.stop();
  tee.stop(); // idempotent
  await feed.close();
});

test("startJobLogTee: a failed DB open disables the tee without throwing", async () => {
  // point dbPath at a directory path that cannot be a file -> openDb throws internally
  const dir = mkdtempSync(join(tmpdir(), "ndh-jl-dir-"));
  mkdirSync(join(dir, "joblogs.db")); // now the db path is a directory
  const tee = startJobLogTee(0, { dbPath: join(dir, "joblogs.db"), hubDbPath: tmp(), baseUrl: "http://127.0.0.1:1", flushMs: 5 });
  await tee.ready; // must resolve, not reject
  tee.stop();
  assert.ok(true);
});

assert.ok(RETENTION_MS > 0);
