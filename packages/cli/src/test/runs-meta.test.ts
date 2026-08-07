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
