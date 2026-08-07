import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  serveRunCancel,
  serveRunDelete,
  serveFilteredRuns,
  serveRunAttempts,
  serveProjectDelete,
  rollUpResult,
  readRunResultRollup,
  __test,
} from "../runctl.js";
import { openDb, JobLogWriter, isRunDeleted } from "../joblogs.js";
import { freshHome, startServer, type Fixture } from "./helpers.js";

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

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "ndh-rc-")), "joblogs.db");
}

// ── splitEnvelope ─────────────────────────────────────────────────────────────
test("splitEnvelope: handles bare arrays, OData wrappers, and junk", () => {
  assert.deepEqual(__test.splitEnvelope([{ id: 1 }]), { runs: [{ id: 1 }], wrapped: false });
  assert.deepEqual(__test.splitEnvelope({ value: [{ id: 2 }] }), { runs: [{ id: 2 }], wrapped: true });
  assert.deepEqual(__test.splitEnvelope(null), { runs: [], wrapped: true });
  assert.deepEqual(__test.splitEnvelope({ value: "nope" }), { runs: [], wrapped: true });
});

// ── serveRunCancel ────────────────────────────────────────────────────────────
async function cancelHub(): Promise<Fixture & { hits: string[] }> {
  const hits: string[] = [];
  const fx = await startServer((rq, res) => {
    hits.push(`${rq.method} ${rq.url}`);
    if (/\/_apis\/v1\/Message\/(force)?[cC]ancelWorkflow\/\d+$/.test(rq.url ?? "")) {
      res.writeHead(200);
      return void res.end();
    }
    res.writeHead(404);
    res.end();
  });
  return { ...fx, hits };
}

test("serveRunCancel: posts cancelWorkflow and returns ok", async () => {
  const hub = await cancelHub();
  const c = capRes();
  try {
    await serveRunCancel(hub.port, 42, false, c.res);
    assert.equal(c.rec.code, 200);
    assert.deepEqual(JSON.parse(c.rec.body!), { ok: true, runId: 42, forced: false });
    assert.ok(hub.hits.some((h) => h === "POST /_apis/v1/Message/cancelWorkflow/42"));
  } finally {
    await hub.close();
  }
});

test("serveRunCancel: force uses forceCancelWorkflow", async () => {
  const hub = await cancelHub();
  const c = capRes();
  try {
    await serveRunCancel(hub.port, 7, true, c.res);
    assert.equal(c.rec.code, 200);
    assert.equal(JSON.parse(c.rec.body!).forced, true);
    assert.ok(hub.hits.some((h) => h === "POST /_apis/v1/Message/forceCancelWorkflow/7"));
  } finally {
    await hub.close();
  }
});

test("serveRunCancel: 502 when the engine returns non-OK", async () => {
  const hub = await startServer((_q, r) => {
    r.writeHead(500);
    r.end();
  });
  const c = capRes();
  try {
    await serveRunCancel(hub.port, 1, false, c.res);
    assert.equal(c.rec.code, 502);
    assert.equal(JSON.parse(c.rec.body!).ok, false);
  } finally {
    await hub.close();
  }
});

test("serveRunCancel: 502 when the engine is unreachable", async () => {
  const c = capRes();
  // Port 1 is not listening → fetch rejects.
  await serveRunCancel(1, 1, false, c.res);
  assert.equal(c.rec.code, 502);
});

// ── serveRunDelete ────────────────────────────────────────────────────────────
test("serveRunDelete: purges + tombstones and reports the count", async () => {
  const path = tmpDb();
  const db = await openDb(path);
  new JobLogWriter(db, 10_000, 1).add([{ runId: 5, timelineId: "t5", recordId: null, ts: 1, line: "a" }]);
  db.close();
  const c = capRes();
  await serveRunDelete(5, c.res, path);
  assert.equal(c.rec.code, 200);
  assert.deepEqual(JSON.parse(c.rec.body!), { ok: true, runId: 5, logsPurged: 1 });
  assert.equal(await isRunDeleted(path, 5), true);
});

test("serveRunDelete: 500 when the delete cannot open its database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ndh-rc-dir-"));
  mkdirSync(join(dir, "joblogs.db")); // db path is a directory → openDb throws
  const c = capRes();
  await serveRunDelete(1, c.res, join(dir, "joblogs.db"));
  assert.equal(c.rec.code, 500);
  assert.equal(JSON.parse(c.rec.body!).ok, false);
});

// ── serveFilteredRuns ─────────────────────────────────────────────────────────
async function runsHub(payload: unknown, status = 200): Promise<Fixture & { search: () => string }> {
  let search = "";
  const fx = await startServer((rq, res) => {
    search = new URL(rq.url ?? "/", "http://x").search;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return { ...fx, search: () => search };
}

test("serveFilteredRuns: drops tombstoned runs from a bare array and keeps id-less rows", async () => {
  const path = tmpDb();
  const db = await openDb(path);
  new JobLogWriter(db, 10_000, 1).add([{ runId: 2, timelineId: "t2", recordId: null, ts: 1, line: "x" }]);
  (await import("../joblogs.js")).markRunDeleted(db, 2);
  db.close();
  const hub = await runsHub([{ id: 1 }, { id: 2 }, { noId: true }]);
  const c = capRes();
  try {
    await serveFilteredRuns(hub.port, "?page=0", c.res, path);
    assert.equal(c.rec.code, 200);
    assert.deepEqual(JSON.parse(c.rec.body!), [{ id: 1 }, { noId: true }]);
    assert.equal(hub.search(), "?page=0"); // query string is forwarded
  } finally {
    await hub.close();
  }
});

test("serveFilteredRuns: preserves the OData envelope shape", async () => {
  const path = tmpDb();
  const db = await openDb(path);
  (await import("../joblogs.js")).markRunDeleted(db, 9);
  db.close();
  const hub = await runsHub({ count: 2, value: [{ id: 8 }, { id: 9 }] });
  const c = capRes();
  try {
    await serveFilteredRuns(hub.port, "", c.res, path);
    assert.deepEqual(JSON.parse(c.rec.body!), { count: 1, value: [{ id: 8 }] });
  } finally {
    await hub.close();
  }
});

test("serveFilteredRuns: forwards a non-OK engine status", async () => {
  const hub = await runsHub([], 503);
  const c = capRes();
  try {
    await serveFilteredRuns(hub.port, "", c.res, tmpDb());
    assert.equal(c.rec.code, 503);
  } finally {
    await hub.close();
  }
});

test("serveFilteredRuns: 502 when the engine is unreachable", async () => {
  const c = capRes();
  await serveFilteredRuns(1, "", c.res, tmpDb());
  assert.equal(c.rec.code, 502);
});

test("serveFilteredRuns: tolerates a non-JSON body (treated as empty)", async () => {
  const hub = await startServer((_q, r) => {
    r.writeHead(200, { "content-type": "application/json" });
    r.end("not json");
  });
  const c = capRes();
  try {
    await serveFilteredRuns(hub.port, "", c.res, tmpDb());
    assert.equal(c.rec.code, 200);
    assert.deepEqual(JSON.parse(c.rec.body!), []);
  } finally {
    await hub.close();
  }
});

// ── serveProjectDelete (bulk by project) ──────────────────────────────────────
/** Fake hub serving a runs list (used by fetchProjectRuns). */
async function projectRunsHub(runs: unknown[]): Promise<Fixture> {
  return startServer((rq, res) => {
    const u = new URL(rq.url ?? "/", "http://x");
    if (u.pathname === "/_apis/v1/Message/workflow/runs") {
      // page 0 → the runs; any later page → empty (ends the loop)
      const page = Number(u.searchParams.get("page") ?? "0");
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(page === 0 ? runs : []));
    }
    res.writeHead(404);
    res.end();
  });
}

test("serveProjectDelete: 400 when no project is given", async () => {
  const c = capRes();
  await serveProjectDelete(1, null, c.res, tmpDb());
  assert.equal(c.rec.code, 400);
  assert.equal(JSON.parse(c.rec.body!).ok, false);
});

test("serveProjectDelete: deletes only the project's runs and tombstones them", async () => {
  freshHome();
  const path = tmpDb();
  const hub = await projectRunsHub([
    { id: 1, owner: "acme", repo: "widget" },
    { id: 2, owner: "acme", repo: "widget" },
    { id: 3, owner: "local", repo: "scratch" },
  ]);
  const c = capRes();
  try {
    await serveProjectDelete(hub.port, "acme/widget", c.res, path);
    assert.equal(c.rec.code, 200);
    const body = JSON.parse(c.rec.body!);
    assert.equal(body.deleted, 2);
    assert.equal(body.failed, 0);
    assert.deepEqual(body.runIds, [1, 2]);
    assert.equal(await isRunDeleted(path, 1), true);
    assert.equal(await isRunDeleted(path, 2), true);
    assert.equal(await isRunDeleted(path, 3), false);
  } finally {
    await hub.close();
  }
});

test("serveProjectDelete: 502 when the hub runs list is unreachable", async () => {
  const c = capRes();
  await serveProjectDelete(1, "acme/widget", c.res, tmpDb());
  assert.equal(c.rec.code, 502);
});

// ── canceled-vs-failed roll-up (#156) ─────────────────────────────────────────
test("rollUpResult: canceled only when nothing failed, else defers to the engine", () => {
  assert.equal(rollUpResult(["canceled"]), "canceled");
  assert.equal(rollUpResult(["succeeded", "cancelled"]), "canceled"); // British spelling too
  assert.equal(rollUpResult(["failed", "canceled"]), null); // a real failure dominates a cancel
  assert.equal(rollUpResult(["failure", "canceled"]), null);
  assert.equal(rollUpResult(["succeeded"]), null); // no cancel → no opinion
  assert.equal(rollUpResult([]), null);
});

test("jobResultString: maps only the codes the correction cares about", () => {
  assert.equal(__test.jobResultString(2), "failed");
  assert.equal(__test.jobResultString(3), "canceled");
  assert.equal(__test.jobResultString(0), "");
  assert.equal(__test.jobResultString(null), "");
});

/**
 * Seed a hub.db with the WorkflowRunAttempt + Jobs shape readRunResultRollup reads.
 * Column subsets match the real runner.server schema (verified against a live hub.db,
 * where a canceled run's attempt Result=2 (failed) while its job Result=3 (canceled)).
 */
function seedRollupDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ndh-rollup-"));
  mkdirSync(join(dir, "hub"), { recursive: true });
  const p = join(dir, "hub", "hub.db");
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE WorkflowRunAttempt (Id INTEGER, WorkflowRunId INTEGER, Attempt INTEGER)`);
  db.exec(`CREATE TABLE Jobs (WorkflowRunAttemptId INTEGER, Result INTEGER, runid INTEGER)`);
  const attempt = (id: number, run: number | null, n: number) =>
    db.exec(`INSERT INTO WorkflowRunAttempt VALUES (${id}, ${run === null ? "NULL" : run}, ${n})`);
  const job = (attemptId: number, result: number, run: number) =>
    db.exec(`INSERT INTO Jobs VALUES (${attemptId}, ${result}, ${run})`);
  // Run 100: a single canceled job (engine mislabels the attempt "failed").
  attempt(1000, 100, 1);
  job(1000, 3, 100);
  // Run 101: a genuine failure — must NOT be corrected.
  attempt(1010, 101, 1);
  job(1010, 2, 101);
  // Run 102: a job failed AND another was canceled — the failure dominates.
  attempt(1020, 102, 1);
  job(1020, 2, 102);
  job(1020, 3, 102);
  // Run 103: a re-run — attempt 1 was canceled, attempt 2 succeeded. Only the NEWEST attempt counts.
  attempt(1030, 103, 1);
  job(1030, 3, 103);
  attempt(1031, 103, 2);
  job(1031, 0, 103);
  // An orphan attempt with no run id must be ignored, not crash the read.
  attempt(9999, null, 1);
  db.close();
  return p;
}

test("readRunResultRollup: rolls up per attempt, scoped to the newest attempt", async () => {
  const rollup = await readRunResultRollup(seedRollupDb());
  assert.equal(rollup.byAttemptId.get(1000), "canceled");
  assert.equal(rollup.byAttemptId.get(1030), "canceled"); // the old, canceled attempt of run 103
  assert.equal(rollup.byAttemptId.has(1010), false); // a genuine failure is never in the map
  assert.equal(rollup.byAttemptId.has(1020), false);
  assert.equal(rollup.latestAttemptId.get(100), 1000);
  assert.equal(rollup.latestAttemptId.get(103), 1031); // newest attempt, not the canceled one
});

test("readRunResultRollup: an unreadable DB yields no corrections", async () => {
  const rollup = await readRunResultRollup(join(tmpdir(), "ndh-nope", "does-not-exist.db"));
  assert.equal(rollup.byAttemptId.size, 0);
  assert.equal(rollup.latestAttemptId.size, 0);
});

test("readRunResultRollup: a foreign-schema hub.db (no Result column) yields no corrections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ndh-foreign-"));
  mkdirSync(join(dir, "hub"), { recursive: true });
  const p = join(dir, "hub", "hub.db");
  const db = new DatabaseSync(p);
  // The runs-meta minimal schema: no Result column on Jobs → the roll-up query throws internally.
  db.exec(`CREATE TABLE Jobs (JobId TEXT, TimeLineId TEXT, runid INTEGER)`);
  db.exec(`CREATE TABLE WorkflowRunAttempt (Id INTEGER, WorkflowRunId INTEGER, Attempt INTEGER)`);
  db.close();
  const rollup = await readRunResultRollup(p);
  assert.equal(rollup.byAttemptId.size, 0);
  assert.equal(rollup.latestAttemptId.size, 0);
});

test("applyCancelCorrection: runs the correction, and swallows any failure (best-effort)", async () => {
  const p = seedRollupDb();
  let seen: string | undefined;
  await __test.applyCancelCorrection(p, (rollup) => {
    seen = rollup.byAttemptId.get(1000);
  });
  assert.equal(seen, "canceled"); // the correction callback actually ran against the roll-up
  // A throwing callback must never reject — the read endpoint serves the engine's data unchanged.
  await assert.doesNotReject(
    __test.applyCancelCorrection(p, () => {
      throw new Error("boom");
    }),
  );
});

test("serveRunAttempts: a foreign-schema hub.db passes the engine's attempts through (no 4xx/5xx)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ndh-foreign2-"));
  mkdirSync(join(dir, "hub"), { recursive: true });
  const p = join(dir, "hub", "hub.db");
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE Jobs (JobId TEXT, TimeLineId TEXT, runid INTEGER)`); // no Result column
  db.close();
  const hub = await attemptsHub([{ id: 1000, attempt: 1, result: "failed" }]);
  const c = capRes();
  try {
    await serveRunAttempts(hub.port, 100, c.res, p);
    assert.equal(c.rec.code, 200); // never a 400/500 from the correction path
    assert.deepEqual(JSON.parse(c.rec.body!), [{ id: 1000, attempt: 1, result: "failed" }]);
  } finally {
    await hub.close();
  }
});

test("isMislabeledCancel: only a failure-like NEWEST attempt that actually canceled", async () => {
  const rollup = await readRunResultRollup(seedRollupDb());
  assert.equal(__test.isMislabeledCancel("failed", 100, rollup), true);
  assert.equal(__test.isMislabeledCancel("failure", 100, rollup), true);
  assert.equal(__test.isMislabeledCancel("failed", 103, rollup), false); // newest attempt succeeded
  assert.equal(__test.isMislabeledCancel("failed", 101, rollup), false); // a genuine failure
  assert.equal(__test.isMislabeledCancel("succeeded", 100, rollup), false); // not failure-like
  assert.equal(__test.isMislabeledCancel(undefined, 100, rollup), false);
  assert.equal(__test.isMislabeledCancel("failed", undefined, rollup), false);
  assert.equal(__test.isMislabeledCancel("failed", 777, rollup), false); // unknown run
});

test("serveFilteredRuns: rewrites a mislabeled canceled run to 'canceled', leaves real failures", async () => {
  const hub = await runsHub([
    { id: 100, result: "failed" }, // canceled run the engine called failed
    { id: 101, result: "failed" }, // genuine failure
    { id: 102, result: "failed" }, // failure + cancel → still failed
  ]);
  const c = capRes();
  try {
    await serveFilteredRuns(hub.port, "", c.res, tmpDb(), seedRollupDb());
    assert.deepEqual(JSON.parse(c.rec.body!), [
      { id: 100, result: "canceled" },
      { id: 101, result: "failed" },
      { id: 102, result: "failed" },
    ]);
  } finally {
    await hub.close();
  }
});

/** Fake hub serving a run's attempts payload verbatim (used by serveRunAttempts). */
async function attemptsHub(payload: unknown, status = 200): Promise<Fixture> {
  return startServer((_rq, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
}

test("serveRunAttempts: corrects a mislabeled attempt, leaves a genuine failure", async () => {
  const p = seedRollupDb();
  const hub = await attemptsHub([{ id: 1000, attempt: 1, result: "failed" }]);
  const c = capRes();
  try {
    await serveRunAttempts(hub.port, 100, c.res, p);
    assert.deepEqual(JSON.parse(c.rec.body!), [{ id: 1000, attempt: 1, result: "canceled" }]);
  } finally {
    await hub.close();
  }
  const hub2 = await attemptsHub([{ id: 1010, attempt: 1, result: "failed" }]);
  const c2 = capRes();
  try {
    await serveRunAttempts(hub2.port, 101, c2.res, p);
    assert.deepEqual(JSON.parse(c2.rec.body!), [{ id: 1010, attempt: 1, result: "failed" }]);
  } finally {
    await hub2.close();
  }
});

test("serveRunAttempts: preserves the OData envelope and tolerates junk/non-OK/unreachable", async () => {
  const p = seedRollupDb();
  const wrapped = await attemptsHub({ count: 1, value: [{ id: 1000, result: "failed" }] });
  const c = capRes();
  try {
    await serveRunAttempts(wrapped.port, 100, c.res, p);
    assert.deepEqual(JSON.parse(c.rec.body!), { count: 1, value: [{ id: 1000, result: "canceled" }] });
  } finally {
    await wrapped.close();
  }
  const junk = await startServer((_q, r) => {
    r.writeHead(200, { "content-type": "application/json" });
    r.end("not json");
  });
  const c2 = capRes();
  try {
    await serveRunAttempts(junk.port, 100, c2.res, p);
    assert.deepEqual(JSON.parse(c2.rec.body!), []);
  } finally {
    await junk.close();
  }
  const bad = await attemptsHub([], 503);
  const c3 = capRes();
  try {
    await serveRunAttempts(bad.port, 1, c3.res, p);
    assert.equal(c3.rec.code, 503);
  } finally {
    await bad.close();
  }
  const c4 = capRes();
  await serveRunAttempts(1, 1, c4.res, p); // port 1 not listening → 502
  assert.equal(c4.rec.code, 502);
});

test("fetchProjectRuns: pages until a short page and matches on project label", async () => {
  const page0 = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, owner: "acme", repo: "widget" }));
  let calls = 0;
  const hub = await startServer((rq, res) => {
    const u = new URL(rq.url ?? "/", "http://x");
    calls++;
    const page = Number(u.searchParams.get("page") ?? "0");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(page === 0 ? page0 : page === 1 ? [{ id: 99, owner: "acme", repo: "widget" }] : []));
  });
  try {
    const runs = await __test.fetchProjectRuns(hub.port, "acme/widget");
    assert.equal(runs.length, 31);
    assert.ok(calls >= 2, "paged past the first full page");
  } finally {
    await hub.close();
  }
});
