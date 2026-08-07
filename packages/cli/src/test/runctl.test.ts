import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { serveRunCancel, serveRunDelete, serveFilteredRuns, serveProjectDelete, __test } from "../runctl.js";
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
