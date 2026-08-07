import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AddressInfo } from "node:net";
import { startFront, __test as gate } from "../front.js";
import { parseMetaIds, serveRunsMeta, MAX_META_IDS } from "../runs-meta.js";
import { freshHome, startServer } from "./helpers.js";

/*
  GET /api/local/runs-meta?ids=… (issue #96): the batch timing endpoint for the
  runs list. Covers: batching (one request answers many ids from one DB read),
  the local-only gate (403), unknown-id tolerance, malformed-ids 400, the
  in-progress shape (startedAt only), and the no-DB degradation to {}.
  #132 adds `runningJobs` for runs whose latest attempt is in progress: the
  attempt's active/queued jobs as { key, name } — covered below with a
  full-schema DB (WorkflowRunAttempt + job identities), including
  current-attempt-only scoping, finished-run absence, and old-schema tolerance.
*/

/** Seed a hub.db with the Job timeline shape readRunMeta reads (matches fleet.test.ts). */
function makeHubDb(home: string): void {
  const dir = join(home, "hub");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "hub.db"));
  db.exec(`CREATE TABLE Jobs (JobId TEXT, TimeLineId TEXT, runid INTEGER)`);
  db.exec(
    `CREATE TABLE TimeLineRecords (Id TEXT, TimelineId TEXT, RecordType TEXT, WorkerName TEXT, StartTime TEXT, FinishTime TEXT)`,
  );
  // Run 1: finished — 4.1s of wall clock.
  db.exec(`INSERT INTO Jobs VALUES ('j1','TL1',1)`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r1','TL1','Job','runner-a','2026-08-07 06:42:34.833163','2026-08-07 06:42:38.933163')`);
  // Run 2: in progress — a Job record with a start but no finish yet.
  db.exec(`INSERT INTO Jobs VALUES ('j2','TL2',2)`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r2','TL2','Job','runner-b','2026-08-07 07:00:00.000000',NULL)`);
  db.close();
}

/**
 * Seed a hub.db with the FULL job/attempt shape the #132 runningJobs read uses:
 * WorkflowRunAttempt (attempt number + Status; 4 = Completed) plus Jobs rows
 * carrying name/WorkflowIdentifier/WorkflowRunAttemptId. Column subsets match
 * the real runner.server schema (verified against a live hub.db).
 */
function makeRichHubDb(home: string): void {
  const dir = join(home, "hub");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "hub.db"));
  db.exec(`CREATE TABLE Jobs (JobId TEXT, TimeLineId TEXT, runid INTEGER, WorkflowRunAttemptId INTEGER, name TEXT, WorkflowIdentifier TEXT)`);
  db.exec(
    `CREATE TABLE TimeLineRecords (Id TEXT, TimelineId TEXT, RecordType TEXT, WorkerName TEXT, StartTime TEXT, FinishTime TEXT)`,
  );
  db.exec(`CREATE TABLE WorkflowRunAttempt (Id INTEGER, WorkflowRunId INTEGER, Attempt INTEGER, Status INTEGER)`);

  // Run 1: IN PROGRESS (attempt 1, Status 1). Three jobs: 'build' finished,
  // 'test' running (started, no finish), 'deploy' queued (no timeline record yet).
  db.exec(`INSERT INTO WorkflowRunAttempt VALUES (11, 1, 1, 1)`);
  db.exec(`INSERT INTO Jobs VALUES ('j1a','TLA',1,11,'build','build')`);
  db.exec(`INSERT INTO Jobs VALUES ('j1b','TLB',1,11,'test','_test')`);
  db.exec(`INSERT INTO Jobs VALUES ('j1c','TLC',1,11,'deploy','deploy')`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r1a','TLA','Job','runner-a','2026-08-07 06:00:00.000000','2026-08-07 06:00:05.000000')`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r1b','TLB','Job','runner-a','2026-08-07 06:00:05.000000',NULL)`);

  // Run 2: FINISHED (attempt 1, Status 4 = Completed) — must never carry runningJobs.
  db.exec(`INSERT INTO WorkflowRunAttempt VALUES (21, 2, 1, 4)`);
  db.exec(`INSERT INTO Jobs VALUES ('j2a','TLD',2,21,'only','only')`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r2a','TLD','Job','runner-b','2026-08-07 07:00:00.000000','2026-08-07 07:00:01.000000')`);

  // Run 3: RE-RUN — attempt 1 (Status 4) left an unfinished-looking job behind;
  // attempt 2 (Status 1) is the CURRENT one with 'fresh' running. Only attempt 2's
  // job may be reported.
  db.exec(`INSERT INTO WorkflowRunAttempt VALUES (31, 3, 1, 4)`);
  db.exec(`INSERT INTO WorkflowRunAttempt VALUES (32, 3, 2, 1)`);
  db.exec(`INSERT INTO Jobs VALUES ('j3a','TLE',3,31,'stale','stale')`);
  db.exec(`INSERT INTO Jobs VALUES ('j3b','TLF',3,32,'fresh','fresh')`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r3a','TLE','Job','runner-a','2026-08-07 08:00:00.000000',NULL)`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r3b','TLF','Job','runner-b','2026-08-07 08:10:00.000000',NULL)`);

  // Run 4: QUEUED — attempt in progress, one job, no timeline records at all.
  // Its meta entry exists purely for runningJobs (no times fabricated). The job
  // has no WorkflowIdentifier, so the name doubles as the alias key. A twin row
  // with the same identity (matrix leg replay) must collapse to one entry, and a
  // row with neither name nor identifier is skipped.
  db.exec(`INSERT INTO WorkflowRunAttempt VALUES (41, 4, 1, 0)`);
  db.exec(`INSERT INTO Jobs VALUES ('j4a','TLG',4,41,'solo',NULL)`);
  db.exec(`INSERT INTO Jobs VALUES ('j4b','TLG2',4,41,'solo',NULL)`);
  db.exec(`INSERT INTO Jobs VALUES ('j4c','TLG3',4,41,NULL,NULL)`);
  db.close();
}

function req(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject);
    r.end();
  });
}

async function front(hubPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = startFront({ port: 0, uiDir: null, hubPort });
  await new Promise((r) => server.once("listening", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) };
}

// ── parseMetaIds ──────────────────────────────────────────────────────────────
test("parseMetaIds: parses, trims and dedupes comma-separated run ids", () => {
  assert.deepEqual(parseMetaIds("1,2,3"), [1, 2, 3]);
  assert.deepEqual(parseMetaIds(" 7 , 7 ,8,"), [7, 8]);
});

test("parseMetaIds: rejects missing, empty, non-numeric and oversized input", () => {
  assert.equal(parseMetaIds(null), null);
  assert.equal(parseMetaIds(""), null);
  assert.equal(parseMetaIds(","), null);
  assert.equal(parseMetaIds("1,x"), null);
  assert.equal(parseMetaIds("-1"), null);
  assert.equal(parseMetaIds("1.5"), null);
  const tooMany = Array.from({ length: MAX_META_IDS + 1 }, (_, i) => i + 1).join(",");
  assert.equal(parseMetaIds(tooMany), null);
  // Exactly at the cap is accepted.
  const atCap = Array.from({ length: MAX_META_IDS }, (_, i) => i + 1).join(",");
  assert.equal(parseMetaIds(atCap)?.length, MAX_META_IDS);
});

// ── the endpoint through the front (loopback) ────────────────────────────────
test("GET /api/local/runs-meta: one request answers the whole batch; unknown ids are simply absent", async () => {
  const home = freshHome();
  makeHubDb(home);
  const hub = await startServer((_q, r) => r.end());
  const f = await front(hub.port);
  try {
    const res = await req(f.port, "/api/local/runs-meta?ids=1,2,999");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    // Run 1 (finished): exact ISO times + exact duration from the DB strings.
    assert.deepEqual(body["1"], {
      startedAt: "2026-08-07T06:42:34.833Z",
      finishedAt: "2026-08-07T06:42:38.933Z",
      durationMs: 4100,
    });
    // Run 2 (in progress): startedAt only — no finish, no duration, nothing fabricated.
    assert.deepEqual(body["2"], { startedAt: "2026-08-07T07:00:00.000Z" });
    // Run 999 (unknown): tolerated — absent from the map, not an error.
    assert.equal("999" in body, false);
    assert.deepEqual(Object.keys(body).sort(), ["1", "2"]);
  } finally {
    await f.close();
    await hub.close();
  }
});

// ── #132 runningJobs: active jobs of the current attempt ─────────────────────
test("GET /api/local/runs-meta: one batched request reports runningJobs for every in-progress run", async () => {
  const home = freshHome();
  makeRichHubDb(home);
  const hub = await startServer((_q, r) => r.end());
  const f = await front(hub.port);
  try {
    // ONE request answers all four runs — the endpoint never queries per run.
    const res = await req(f.port, "/api/local/runs-meta?ids=1,2,3,4");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    // Run 1 (in progress): the running job AND the queued job (no timeline record
    // yet) are listed with their alias keys; the finished 'build' job is not.
    assert.deepEqual(body["1"].runningJobs, [
      { key: "_test", name: "test" },
      { key: "deploy", name: "deploy" },
    ]);
    assert.equal(body["1"].startedAt, "2026-08-07T06:00:00.000Z");
    // Run 2 (finished): backward-compatible shape — no runningJobs field at all.
    assert.equal("runningJobs" in body["2"], false);
    assert.equal(body["2"].durationMs, 1000);
    // Run 3 (re-run): ONLY the current attempt's job — attempt 1's leftover
    // unfinished record must not resurface as "running".
    assert.deepEqual(body["3"].runningJobs, [{ key: "fresh", name: "fresh" }]);
    // Run 4 (queued, never started): entry exists purely for runningJobs — no
    // fabricated times; the name doubles as key when WorkflowIdentifier is null,
    // the identical twin row collapses, and the nameless row is skipped.
    assert.deepEqual(body["4"], { runningJobs: [{ key: "solo", name: "solo" }] });
  } finally {
    await f.close();
    await hub.close();
  }
});

test("GET /api/local/runs-meta: hub DB without attempt/job-identity columns still serves timing (no runningJobs)", async () => {
  const home = freshHome();
  makeHubDb(home); // the minimal pre-#132 schema: no WorkflowRunAttempt table
  const hub = await startServer((_q, r) => r.end());
  const f = await front(hub.port);
  try {
    const res = await req(f.port, "/api/local/runs-meta?ids=1,2");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body["1"].durationMs, 4100); // timing intact
    assert.equal("runningJobs" in body["1"], false);
    assert.equal("runningJobs" in body["2"], false); // even for the in-progress run
  } finally {
    await f.close();
    await hub.close();
  }
});

test("GET /api/local/runs-meta: malformed or missing ids → 400", async () => {
  const home = freshHome();
  makeHubDb(home);
  const hub = await startServer((_q, r) => r.end());
  const f = await front(hub.port);
  try {
    assert.equal((await req(f.port, "/api/local/runs-meta")).status, 400);
    assert.equal((await req(f.port, "/api/local/runs-meta?ids=")).status, 400);
    assert.equal((await req(f.port, "/api/local/runs-meta?ids=1,abc")).status, 400);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("GET /api/local/runs-meta: no hub DB degrades to an empty map, not an error", async () => {
  freshHome(); // no makeHubDb
  const hub = await startServer((_q, r) => r.end());
  const f = await front(hub.port);
  try {
    const res = await req(f.port, "/api/local/runs-meta?ids=1,2");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), {});
  } finally {
    await f.close();
    await hub.close();
  }
});

// ── gate: same local-only rule as the other /api/local reads ─────────────────
test("handleRequest: /api/local/runs-meta denied for non-loopback without basic auth (403)", async () => {
  const rec: { code?: number } = {};
  const res = {
    set statusCode(_v: number) {},
    writeHead(code: number) {
      rec.code = code;
    },
    end() {},
  } as never as http.ServerResponse;
  const rq = {
    socket: { remoteAddress: "10.0.0.4" },
    headers: {},
    url: "/api/local/runs-meta?ids=1",
    method: "GET",
  } as never as http.IncomingMessage;
  await gate.handleRequest(rq, res, { basicAuth: undefined } as never, async () => null);
  assert.equal(rec.code, 403);
});

// ── serveRunsMeta directly: zoned timestamps + explicit db path ──────────────
test("serveRunsMeta: already-zoned timestamps parse via the fallback path", async () => {
  const home = freshHome();
  const dir = join(home, "hub");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "alt.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE Jobs (JobId TEXT, TimeLineId TEXT, runid INTEGER)`);
  db.exec(
    `CREATE TABLE TimeLineRecords (Id TEXT, TimelineId TEXT, RecordType TEXT, WorkerName TEXT, StartTime TEXT, FinishTime TEXT)`,
  );
  db.exec(`INSERT INTO Jobs VALUES ('j5','TL5',5)`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r5','TL5','Job','w','2026-08-07T09:00:00.000Z','2026-08-07T09:00:01.500Z')`);
  db.close();

  const rec: { code?: number; body?: string } = {};
  const res = {
    writeHead(code: number) {
      rec.code = code;
    },
    end(b?: string) {
      rec.body = b;
    },
  } as never as http.ServerResponse;
  await serveRunsMeta("5", res, dbPath);
  assert.equal(rec.code, 200);
  const body = JSON.parse(rec.body ?? "{}");
  assert.equal(body["5"].startedAt, "2026-08-07T09:00:00.000Z");
  assert.equal(body["5"].finishedAt, "2026-08-07T09:00:01.500Z");
});
