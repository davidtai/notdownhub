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
  purgeRunLogs,
  markRunDeleted,
  deleteRun,
  resolveRunTimelines,
  readDeletedRunIds,
  isRunDeleted,
  readJobLog,
  serveJobLogs,
  makeRunIdResolver,
  startJobLogTee,
  backfillCompletedJobs,
  splitUploadedLog,
  storedRunId,
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

// ── true delete: purge + tombstone ───────────────────────────────────────────
test("purgeRunLogs: removes a run's rows (by run_id and via streams) and leaves other runs", async () => {
  const path = tmp();
  const db = await openDb(path);
  const w = new JobLogWriter(db, 10_000, 1);
  w.add([{ runId: 5, timelineId: "tl5", recordId: null, ts: 1, line: "a" }]);
  w.add([{ runId: 5, timelineId: "tl5", recordId: null, ts: 2, line: "b" }]);
  w.add([{ runId: 6, timelineId: "tl6", recordId: null, ts: 3, line: "c" }]);
  const removed = purgeRunLogs(db, 5);
  assert.equal(removed, 2);
  assert.equal((await readJobLog(path, "tl5"))!.length, 0);
  assert.deepEqual(await readJobLog(path, "tl6"), ["c"]);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM streams WHERE run_id=5").get() as { n: number }).n, 0);
  db.close();
});

test("purgeRunLogs: removes rows keyed only by timeline_id (NULL run_id) via resolved timelines", async () => {
  const path = tmp();
  const db = await openDb(path);
  const w = new JobLogWriter(db, 10_000, 1);
  // Rows the tee stored before the run_id resolved: run_id NULL, keyed by timeline.
  w.add([{ runId: null, timelineId: "tln", recordId: null, ts: 1, line: "orphan-line" }]);
  w.add([{ runId: null, timelineId: "keep", recordId: null, ts: 2, line: "other" }]);
  const removed = purgeRunLogs(db, 99, ["tln"]); // run_id 99 matches nothing; timeline does
  assert.equal(removed, 1);
  assert.equal((await readJobLog(path, "tln"))!.length, 0);
  assert.deepEqual(await readJobLog(path, "keep"), ["other"]);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM streams WHERE timeline_id='tln'").get() as { n: number }).n, 0);
  db.close();
});

test("resolveRunTimelines: lower-cases hub-DB TimeLineIds for a run; [] on a missing db/table", async () => {
  const hubPath = tmp();
  const hub = new DatabaseSync(hubPath);
  hub.exec("CREATE TABLE Jobs(JobId TEXT, TimeLineId TEXT, runid INTEGER)");
  hub.prepare("INSERT INTO Jobs(TimeLineId,runid) VALUES(?,?)").run("ABC-UPPER", 7);
  hub.prepare("INSERT INTO Jobs(TimeLineId,runid) VALUES(?,?)").run("DEF-UPPER", 7);
  hub.prepare("INSERT INTO Jobs(TimeLineId,runid) VALUES(?,?)").run("OTHER", 8);
  hub.close();
  assert.deepEqual((await resolveRunTimelines(hubPath, 7)).sort(), ["abc-upper", "def-upper"]);
  assert.deepEqual(await resolveRunTimelines(join(tmpdir(), "no-such-hub", "h.db"), 7), []);
});

test("deleteRun: resolves timelines from the hub DB and purges NULL-run_id rows", async () => {
  const path = tmp();
  const hubPath = tmp();
  const hub = new DatabaseSync(hubPath);
  hub.exec("CREATE TABLE Jobs(JobId TEXT, TimeLineId TEXT, runid INTEGER)");
  hub.prepare("INSERT INTO Jobs(TimeLineId,runid) VALUES(?,?)").run("TL-UP", 12);
  hub.close();
  const db = await openDb(path);
  new JobLogWriter(db, 10_000, 1).add([{ runId: null, timelineId: "tl-up", recordId: null, ts: 1, line: "z" }]);
  db.close();
  const r = await deleteRun(path, 12, { hubDbPath: hubPath });
  assert.equal(r.logsPurged, 1);
  assert.equal(await isRunDeleted(path, 12), true);
});

test("markRunDeleted: purges logs, writes a timestamped tombstone, in one transaction", async () => {
  const path = tmp();
  const db = await openDb(path);
  new JobLogWriter(db, 10_000, 1).add([{ runId: 9, timelineId: "t9", recordId: null, ts: 1, line: "x" }]);
  const purged = markRunDeleted(db, 9, [], () => 12345);
  assert.equal(purged, 1);
  assert.equal((db.prepare("SELECT deleted_at FROM deleted_runs WHERE run_id=9").get() as { deleted_at: number }).deleted_at, 12345);
  assert.equal((await readJobLog(path, "t9"))!.length, 0);
  db.close();
});

test("markRunDeleted: rolls back and rethrows when the tombstone insert fails", async () => {
  const path = tmp();
  const db = await openDb(path);
  new JobLogWriter(db, 10_000, 1).add([{ runId: 1, timelineId: "t1", recordId: null, ts: 1, line: "keep-on-rollback" }]);
  db.exec("DROP TABLE deleted_runs"); // make the INSERT inside the transaction fail
  assert.throws(() => markRunDeleted(db, 1));
  // the log purge is rolled back with the failed insert — nothing is half-deleted
  assert.deepEqual(await readJobLog(path, "t1"), ["keep-on-rollback"]);
  db.close();
});

test("deleteRun + readDeletedRunIds + isRunDeleted: opens the db, tombstones, reports purge count", async () => {
  const home = freshHome();
  const path = join(home, "hub", "joblogs.db");
  const db = await openDb(path);
  new JobLogWriter(db, 10_000, 1).add([{ runId: 3, timelineId: "t3", recordId: null, ts: 1, line: "y" }]);
  db.close();
  const r = await deleteRun(path, 3);
  assert.equal(r.logsPurged, 1);
  assert.equal(await isRunDeleted(path, 3), true);
  assert.equal(await isRunDeleted(path, 4), false);
  assert.deepEqual([...(await readDeletedRunIds(path))], [3]);
});

test("readDeletedRunIds: empty set when the database is missing", async () => {
  assert.equal((await readDeletedRunIds(join(tmpdir(), "does-not-exist-del", "j.db"))).size, 0);
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

test("serveJobLogs: 404 on a mismatched runId, 200 with lines on the right one (#81)", async () => {
  const home = freshHome();
  const db = await openDb(join(home, "hub", "joblogs.db"));
  new JobLogWriter(db, 10_000, 1).add([{ runId: 7, timelineId: "tl-owned", recordId: null, ts: 1, line: "mine" }]);
  db.close();
  const wrong = capRes();
  await serveJobLogs("/api/local/joblogs/9/tl-owned", wrong.res);
  assert.equal(wrong.rec.code, 404, "a timeline paired to run 7 must 404 for run 9");
  assert.match(wrong.rec.body!, /does not belong/);
  const right = capRes();
  await serveJobLogs("/api/local/joblogs/7/tl-owned", right.res);
  assert.equal(right.rec.code, 200);
  assert.deepEqual(JSON.parse(right.rec.body!), { retained: true, lines: ["mine"] });
});

// ── completion backfill (#80) ────────────────────────────────────────────────
/** A hub DB with the three tables the backfill reads (Jobs, TimeLineRecords, Logs). */
function fakeHub(path: string): DatabaseSync {
  const hub = new DatabaseSync(path);
  hub.exec("CREATE TABLE Jobs(JobId TEXT, TimeLineId TEXT, runid INTEGER)");
  hub.exec("CREATE TABLE TimeLineRecords(Id TEXT, TimelineId TEXT, LogId INTEGER, RecordType TEXT, FinishTime TEXT)");
  hub.exec("CREATE TABLE Logs(Id INTEGER PRIMARY KEY, Content TEXT, RefId INTEGER)");
  return hub;
}

/** Seed one finished job (upper-cased ids, like the real hub) with an uploaded full log. */
function seedFinishedJob(hub: DatabaseSync, runId: number, tlUpper: string, logId: number, lines: string[], finished: string | null = new Date().toISOString()): void {
  hub.prepare("INSERT INTO Jobs(TimeLineId,runid) VALUES(?,?)").run(tlUpper, runId);
  hub.prepare("INSERT INTO TimeLineRecords(Id,TimelineId,LogId,RecordType,FinishTime) VALUES(?,?,?,?,?)").run(tlUpper, tlUpper, logId, "Job", finished);
  const content = lines.map((l) => `2026-08-07T00:00:00.0000000Z ${l}`).join("\n") + "\n";
  hub.prepare("INSERT INTO Logs(Id,Content,RefId) VALUES(?,?,?)").run(logId, content, logId);
}

test("splitUploadedLog: strips CR, the runner timestamp prefix, and ANSI; drops the trailing blank", () => {
  const raw = "2026-08-07T04:29:51.7835504Z plain\r\n2026-08-07T04:29:51.79Z \x1b[32mgreen\x1b[0m\nno timestamp\n";
  assert.deepEqual(splitUploadedLog(raw), ["plain", "green", "no timestamp"]);
});

test("backfillCompletedJobs: replaces the truncated tee with the complete 5000-line job log (#80)", async () => {
  const path = tmp();
  const db = await openDb(path);
  const hub = fakeHub(tmp());
  const full = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} - the quick brown fox ${i + 1}`);
  seedFinishedJob(hub, 12, "BIGJOB-TL", 75, full);
  // a per-step (Task) record with its own log must be ignored — the Job log has it all
  hub.prepare("INSERT INTO TimeLineRecords(Id,TimelineId,LogId,RecordType,FinishTime) VALUES(?,?,?,?,?)").run("STEP", "BIGJOB-TL", 76, "Task", new Date().toISOString());
  hub.prepare("INSERT INTO Logs(Id,Content,RefId) VALUES(?,?,?)").run(76, "step-only\n", 76);
  // the throttled feed persisted only the first 1011 lines, with run_id unresolved
  const w = new JobLogWriter(db, 10_000, 20_000);
  w.add(full.slice(0, 1011).map((line) => ({ runId: null, timelineId: "bigjob-tl", recordId: null, ts: 1, line })));
  w.flush();
  assert.equal((await readJobLog(path, "bigjob-tl"))!.length, 1011);

  assert.deepEqual(backfillCompletedJobs(db, hub), ["bigjob-tl"]);
  const lines = (await readJobLog(path, "bigjob-tl"))!;
  assert.equal(lines.length, 5000, "every line of the uploaded job log is persisted");
  assert.equal(lines[0], "line 1 - the quick brown fox 1");
  assert.equal(lines[4999], "line 5000 - the quick brown fox 5000");
  // run_id is stamped from the hub's Jobs row (#81) and the pairing now holds
  assert.equal(await storedRunId(path, "bigjob-tl"), 12);
  assert.equal((await readJobLog(path, "bigjob-tl", 12))!.length, 5000);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM job_logs WHERE run_id=12").get() as { n: number }).n, 5000);
  // idempotent: a second pass finds nothing left to do
  assert.deepEqual(backfillCompletedJobs(db, hub), []);
  hub.close();
  db.close();
});

test("backfillCompletedJobs: joins paged log content in order", async () => {
  const path = tmp();
  const db = await openDb(path);
  const hub = fakeHub(tmp());
  hub.prepare("INSERT INTO Jobs(TimeLineId,runid) VALUES(?,?)").run("PAGED", 3);
  hub.prepare("INSERT INTO TimeLineRecords(Id,TimelineId,LogId,RecordType,FinishTime) VALUES(?,?,?,?,?)").run("PAGED", "PAGED", 9, "job", null); // lower-case RecordType + NULL FinishTime tolerated
  hub.prepare("INSERT INTO Logs(Id,Content,RefId) VALUES(?,?,?)").run(1, "first\nsec", 9);
  hub.prepare("INSERT INTO Logs(Id,Content,RefId) VALUES(?,?,?)").run(2, "ond\nlast\n", 9);
  assert.deepEqual(backfillCompletedJobs(db, hub), ["paged"]);
  assert.deepEqual(await readJobLog(path, "paged"), ["first", "second", "last"]);
  hub.close();
  db.close();
});

test("backfillCompletedJobs: skips tombstoned runs, pre-cutoff jobs, and logs not yet uploaded", async () => {
  const path = tmp();
  const db = await openDb(path);
  const hub = fakeHub(tmp());
  seedFinishedJob(hub, 5, "DELETED-TL", 1, ["never"]);
  markRunDeleted(db, 5); // tombstoned (#77): its log must stay purged
  seedFinishedJob(hub, 6, "ANCIENT-TL", 2, ["too-old"], "2020-01-01T00:00:00.0000000Z"); // pruned era (#84)
  hub.prepare("INSERT INTO Jobs(TimeLineId,runid) VALUES(?,?)").run("PENDING-TL", 7);
  hub.prepare("INSERT INTO TimeLineRecords(Id,TimelineId,LogId,RecordType,FinishTime) VALUES(?,?,?,?,?)").run("PENDING-TL", "PENDING-TL", 99, "Job", new Date().toISOString()); // LogId set, upload not landed
  assert.deepEqual(backfillCompletedJobs(db, hub), []);
  assert.equal((await readJobLog(path, "deleted-tl"))!.length, 0);
  assert.equal((await readJobLog(path, "ancient-tl"))!.length, 0);
  hub.close();
  db.close();
});

test("backfillCompletedJobs: [] when the hub DB has no schema yet; throws on a joblogs write error", async () => {
  const path = tmp();
  const db = await openDb(path);
  const empty = new DatabaseSync(tmp());
  assert.deepEqual(backfillCompletedJobs(db, empty), []); // fresh home: hub tables not created yet
  empty.close();
  const hub = fakeHub(tmp());
  seedFinishedJob(hub, 1, "TL", 1, ["x"]);
  db.exec("DROP TABLE job_logs"); // make the replace transaction fail
  assert.throws(() => backfillCompletedJobs(db, hub));
  hub.close();
  db.close();
});

test("storedRunId: resolved id, null for unknown/unresolved timelines, null on a missing DB", async () => {
  const path = tmp();
  const db = await openDb(path);
  const w = new JobLogWriter(db, 10_000, 1);
  w.add([{ runId: 4, timelineId: "known", recordId: null, ts: 1, line: "a" }]);
  w.add([{ runId: null, timelineId: "unresolved", recordId: null, ts: 1, line: "b" }]);
  db.close();
  assert.equal(await storedRunId(path, "known"), 4);
  assert.equal(await storedRunId(path, "unresolved"), null);
  assert.equal(await storedRunId(path, "absent"), null);
  assert.equal(await storedRunId(join(tmpdir(), "no-such-jl", "j.db"), "known"), null);
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
  // provider form: the handle can appear (or change) after construction
  let handle: DatabaseSync | null = null;
  const lazy = makeRunIdResolver(() => handle);
  assert.equal(lazy("abcdef-upper"), null);
  handle = hub;
  assert.equal(lazy("abcdef-upper"), 42);
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

test("startJobLogTee: a 5000-line stream is persisted completely — the pipeline drops nothing (#80)", async () => {
  const dbPath = tmp();
  const total = 5000;
  const feed = await sseHub((_req, res) => {
    for (let i = 0; i < total; i += 250) {
      const chunk = Array.from({ length: 250 }, (_, k) => `line ${i + k + 1}`);
      res.write(logFrame("hugetl", chunk));
    }
  });
  const tee = startJobLogTee(0, { dbPath, hubDbPath: tmp(), baseUrl: feed.url, flushMs: 5, reconnectMs: 5000, backfillMs: 60_000 });
  await tee.ready;
  let lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines = (await readJobLog(dbPath, "hugetl")) ?? [];
    if (lines.length >= total) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(lines.length, 5000, "every streamed line reaches the database");
  assert.equal(lines[0], "line 1");
  assert.equal(lines[4999], "line 5000");
  tee.stop();
  await feed.close();
});

test("startJobLogTee: backfills the full job log when hub.db appears after startup; drops late frames (#80/#81)", async () => {
  const dbPath = tmp();
  const hubPath = join(mkdtempSync(join(tmpdir(), "ndh-jl-hub-")), "hub.db"); // does not exist yet
  let res1: http.ServerResponse | null = null;
  const feed = await sseHub((_req, res) => {
    res1 = res;
    res.write(logFrame("latetl", ["throttled 1", "throttled 2"])); // the truncated live feed
  });
  const tee = startJobLogTee(0, { dbPath, hubDbPath: hubPath, baseUrl: feed.url, flushMs: 5, reconnectMs: 5000, backfillMs: 60_000 });
  await tee.ready; // hub.db missing here — the old code would have given up forever
  for (let i = 0; i < 100 && ((await readJobLog(dbPath, "latetl")) ?? []).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await storedRunId(dbPath, "latetl"), null, "run_id unresolved while hub.db is absent");
  // the hub creates its DB and the job finishes with a complete uploaded log
  const hub = fakeHub(hubPath);
  const full = Array.from({ length: 2000 }, (_, i) => `full ${i + 1}`);
  seedFinishedJob(hub, 21, "LATETL", 5, full);
  hub.close();
  await tee.backfillNow();
  const lines = (await readJobLog(dbPath, "latetl"))!;
  assert.equal(lines.length, 2000, "the complete uploaded log replaced the truncated tee");
  assert.equal(lines[1999], "full 2000");
  assert.equal(await storedRunId(dbPath, "latetl"), 21, "run_id resolved once hub.db exists (#81)");
  // a straggler frame arriving after the backfill must not append duplicates
  (res1 as http.ServerResponse | null)?.write(logFrame("latetl", ["straggler"]));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(((await readJobLog(dbPath, "latetl")) ?? []).length, 2000);
  tee.stop();
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
