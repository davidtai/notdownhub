import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AddressInfo } from "node:net";
import { startFront, __test as gate } from "../front.js";
import { openDb, JobLogWriter } from "../joblogs.js";
import { freshHome, startServer, type Fixture } from "./helpers.js";

function req(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
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

/** Fake hub: AgentPools + one Agent + isagentonline. */
async function fakeHub(): Promise<Fixture> {
  return startServer((rq, res) => {
    const u = new URL(rq.url ?? "/", "http://x");
    if (u.pathname === "/_apis/v1/AgentPools") return void res.end(JSON.stringify({ value: [{ id: 1 }] }));
    if (u.pathname.startsWith("/_apis/v1/Agent/")) return void res.end(JSON.stringify({ value: [{ id: 1, name: "r1" }] }));
    if (u.pathname === "/_apis/v1/Message/isagentonline") {
      res.writeHead(200);
      return void res.end(JSON.stringify({ online: true }));
    }
    res.writeHead(404);
    res.end();
  });
}

// ---- /api/local/agents ----
test("GET /api/local/agents: loopback returns the enriched runner list (API fallback, no DB)", async () => {
  freshHome();
  const hub = await fakeHub();
  const f = await front(hub.port);
  try {
    const res = await req(f.port, "/api/local/agents");
    assert.equal(res.status, 200);
    const agents = JSON.parse(res.body);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "r1");
    assert.equal(agents[0].state, "idle"); // online via isagentonline, no DB busy signal
  } finally {
    await f.close();
    await hub.close();
  }
});

// ---- /api/local/config ----
test("GET /api/local/config: loopback returns backend + (empty) secrets/vars", async () => {
  freshHome();
  const hub = await startServer((_q, r) => r.end());
  const f = await front(hub.port);
  try {
    const res = await req(f.port, "/api/local/config");
    assert.equal(res.status, 200);
    const cfg = JSON.parse(res.body);
    assert.equal(typeof cfg.backend, "string");
    assert.deepEqual(cfg.secrets, []);
    assert.deepEqual(cfg.vars, []);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("handleRequest: /api/local/config denied for non-loopback without basic auth (403)", async () => {
  const c = capRes();
  await gate.handleRequest(synthReq("10.0.0.4", "/api/local/config"), c.res, { basicAuth: undefined } as never, noMint);
  assert.equal(c.rec.code, 403);
});

// ---- /api/local/joblogs ----
test("GET /api/local/joblogs/<run>/<tl>: loopback returns retained lines when present", async () => {
  const home = freshHome();
  const db = await openDb(join(home, "hub", "joblogs.db"));
  new JobLogWriter(db, 10_000, 1).add([{ runId: 3, timelineId: "tlA", recordId: null, ts: 1, line: "hello world" }]);
  db.close();
  const hub = await startServer((_q, r) => r.end());
  const f = await front(hub.port);
  try {
    const res = await req(f.port, "/api/local/joblogs/3/tlA");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { retained: true, lines: ["hello world"] });
  } finally {
    await f.close();
    await hub.close();
  }
});

test("GET /api/local/joblogs (no ids): 404 malformed", async () => {
  freshHome();
  const hub = await startServer((_q, r) => r.end());
  const f = await front(hub.port);
  try {
    assert.equal((await req(f.port, "/api/local/joblogs")).status, 404);
  } finally {
    await f.close();
    await hub.close();
  }
});

// ---- access gates on the new routes (synthetic non-loopback) ----
interface CapRes {
  res: http.ServerResponse;
  rec: { code?: number; body?: string };
}
function capRes(): CapRes {
  const rec: CapRes["rec"] = {};
  const res = {
    set statusCode(_v: number) {},
    writeHead(code: number) {
      rec.code = code;
    },
    end(b?: string) {
      rec.body = b;
    },
  } as never as http.ServerResponse;
  return { res, rec };
}
const synthReq = (addr: string, url: string) => ({ socket: { remoteAddress: addr }, headers: {}, url, method: "GET" }) as never as http.IncomingMessage;
const noMint = async () => null;

test("handleRequest: /api/local/agents denied for non-loopback without basic auth (403)", async () => {
  const c = capRes();
  await gate.handleRequest(synthReq("10.0.0.4", "/api/local/agents"), c.res, { basicAuth: undefined } as never, noMint);
  assert.equal(c.rec.code, 403);
});

test("handleRequest: /api/local/joblogs denied for non-loopback without basic auth (403)", async () => {
  const c = capRes();
  await gate.handleRequest(synthReq("10.0.0.4", "/api/local/joblogs/1/x"), c.res, { basicAuth: undefined } as never, noMint);
  assert.equal(c.rec.code, 403);
});

// ---- run control: cancel / true delete / list-filter / detail-404 ----
/** Fake hub covering the runs list, a run detail, and cancelWorkflow. */
async function runsAndCancelHub(runs: { id: number; owner?: string; repo?: string }[]): Promise<Fixture & { hits: string[] }> {
  const hits: string[] = [];
  const fx = await startServer((rq, res) => {
    const u = new URL(rq.url ?? "/", "http://x");
    hits.push(`${rq.method} ${u.pathname}`);
    if (u.pathname === "/_apis/v1/Message/workflow/runs") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(runs));
    }
    if (/^\/_apis\/v1\/Message\/(force)?[cC]ancelWorkflow\/\d+$/.test(u.pathname)) {
      res.writeHead(200);
      return void res.end();
    }
    const ma = u.pathname.match(/^\/_apis\/v1\/Message\/workflow\/run\/(\d+)\/attempts$/);
    if (ma) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify([{ id: Number(ma[1]) * 10, attempt: 1, result: "failed" }]));
    }
    const m = u.pathname.match(/^\/_apis\/v1\/Message\/workflow\/run\/(\d+)$/);
    if (m) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ id: Number(m[1]) }));
    }
    res.writeHead(404);
    res.end();
  });
  return { ...fx, hits };
}

test("POST /api/local/runs/:id/cancel: loopback drives the engine's forceCancelWorkflow (200)", async () => {
  freshHome();
  const hub = await runsAndCancelHub([]);
  const f = await front(hub.port);
  try {
    const res = await req(f.port, "/api/local/runs/42/cancel", {}, "POST");
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    // Default cancel = force: soft cancelWorkflow is a no-op for a running job in this engine.
    assert.ok(hub.hits.includes("POST /_apis/v1/Message/forceCancelWorkflow/42"));
  } finally {
    await f.close();
    await hub.close();
  }
});

test("POST /api/local/runs/:id/cancel?soft=1: uses the graceful cancelWorkflow", async () => {
  freshHome();
  const hub = await runsAndCancelHub([]);
  const f = await front(hub.port);
  try {
    const res = await req(f.port, "/api/local/runs/9/cancel?soft=1", {}, "POST");
    assert.equal(res.status, 200);
    assert.ok(hub.hits.includes("POST /_apis/v1/Message/cancelWorkflow/9"));
  } finally {
    await f.close();
    await hub.close();
  }
});

test("GET a live run's attempts routes through the #156 correction end-to-end", async () => {
  const home = freshHome();
  // Seed a CONTROLLED hub.db in this test's own isolated home, so the outcome never depends on
  // ambient/leftover state: attempt id 50 (what the fake engine reports for run 5) has a single
  // canceled job. The front must rewrite the engine's "failed" attempt to "canceled".
  mkdirSync(join(home, "hub"), { recursive: true });
  const db = new DatabaseSync(join(home, "hub", "hub.db"));
  db.exec(`CREATE TABLE WorkflowRunAttempt (Id INTEGER, WorkflowRunId INTEGER, Attempt INTEGER)`);
  db.exec(`CREATE TABLE Jobs (WorkflowRunAttemptId INTEGER, Result INTEGER, runid INTEGER)`);
  db.exec(`INSERT INTO WorkflowRunAttempt VALUES (50, 5, 1)`);
  db.exec(`INSERT INTO Jobs VALUES (50, 3, 5)`); // Result 3 = canceled
  db.close();
  const hub = await runsAndCancelHub([{ id: 5 }]);
  const f = await front(hub.port);
  try {
    // The fake engine reports attempt id 50 as "failed"; the correction makes it "canceled".
    const res = await req(f.port, "/_apis/v1/Message/workflow/run/5/attempts");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), [{ id: 50, attempt: 1, result: "canceled" }]);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("handleRequest: POST cancel denied for non-loopback without basic auth (403)", async () => {
  const c = capRes();
  const rq = { socket: { remoteAddress: "10.0.0.9" }, headers: {}, url: "/api/local/runs/1/cancel", method: "POST" } as never;
  await gate.handleRequest(rq, c.res, { basicAuth: undefined } as never, noMint);
  assert.equal(c.rec.code, 403);
});

test("DELETE /api/local/runs/:id then GET runs: the run is filtered out and its detail 404s", async () => {
  freshHome();
  const hub = await runsAndCancelHub([{ id: 1 }, { id: 2 }]);
  const f = await front(hub.port);
  try {
    // Before delete: both runs listed.
    const before = await req(f.port, "/_apis/v1/Message/workflow/runs?page=0");
    assert.deepEqual(JSON.parse(before.body), [{ id: 1 }, { id: 2 }]);

    // Delete run 2.
    const del = await req(f.port, "/api/local/runs/2", {}, "DELETE");
    assert.equal(del.status, 200);
    assert.equal(JSON.parse(del.body).ok, true);

    // After delete: run 2 gone from the list.
    const after = await req(f.port, "/_apis/v1/Message/workflow/runs?page=0");
    assert.deepEqual(JSON.parse(after.body), [{ id: 1 }]);

    // Detail: run 2 → 404; run 1 → proxied through (200).
    assert.equal((await req(f.port, "/_apis/v1/Message/workflow/run/2")).status, 404);
    assert.equal((await req(f.port, "/_apis/v1/Message/workflow/run/1")).status, 200);
    // A deleted run's attempts/jobs sub-paths 404 too.
    assert.equal((await req(f.port, "/_apis/v1/Message/workflow/run/2/attempts")).status, 404);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("handleRequest: DELETE run denied for non-loopback without basic auth (403)", async () => {
  const c = capRes();
  const rq = { socket: { remoteAddress: "10.0.0.9" }, headers: {}, url: "/api/local/runs/1", method: "DELETE" } as never;
  await gate.handleRequest(rq, c.res, { basicAuth: undefined } as never, noMint);
  assert.equal(c.rec.code, 403);
});

test("OPTIONS /api/local/runs: 204 so the Projects page feature-detects the delete backend", async () => {
  freshHome();
  const hub = await runsAndCancelHub([]);
  const f = await front(hub.port);
  try {
    const res = await req(f.port, "/api/local/runs", {}, "OPTIONS");
    assert.equal(res.status, 204); // non-404 → #73's Remove button lights up
  } finally {
    await f.close();
    await hub.close();
  }
});

test("DELETE /api/local/runs?project=: bulk-deletes the project's runs and filters them out", async () => {
  freshHome();
  const hub = await runsAndCancelHub([
    { id: 1, owner: "acme", repo: "widget" },
    { id: 2, owner: "acme", repo: "widget" },
    { id: 3, owner: "local", repo: "scratch" },
  ]);
  const f = await front(hub.port);
  try {
    const del = await req(f.port, "/api/local/runs?project=acme%2Fwidget", {}, "DELETE");
    assert.equal(del.status, 200);
    const body = JSON.parse(del.body);
    assert.equal(body.deleted, 2);
    assert.deepEqual(body.runIds, [1, 2]);
    // The two acme/widget runs are now filtered from the list; the local/scratch run remains.
    const after = await req(f.port, "/_apis/v1/Message/workflow/runs?page=0");
    assert.deepEqual(JSON.parse(after.body).map((r: { id: number }) => r.id), [3]);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("handleRequest: DELETE ?project= denied for non-loopback without basic auth (403)", async () => {
  const c = capRes();
  const rq = { socket: { remoteAddress: "10.0.0.9" }, headers: {}, url: "/api/local/runs?project=a/b", method: "DELETE" } as never;
  await gate.handleRequest(rq, c.res, { basicAuth: undefined } as never, noMint);
  assert.equal(c.rec.code, 403);
});

// ---- /api/local/projects (distinct projects across the FULL history, #90) ----
test("GET /api/local/projects: loopback returns the full-history aggregate (unpaged engine query)", async () => {
  freshHome();
  const runs = [
    { id: 1, owner: "globex", repo: "beta", fileName: ".github/workflows/t.yml", displayName: "T" },
    { id: 2, owner: "acme", repo: "widget", fileName: ".github/workflows/ci.yml", displayName: "CI" },
    { id: 3, owner: "acme", repo: "widget", fileName: ".github/workflows/ci.yml", displayName: "CI" },
  ];
  const hub = await runsAndCancelHub(runs);
  const f = await front(hub.port);
  try {
    const res = await req(f.port, "/api/local/projects");
    assert.equal(res.status, 200);
    const projects = JSON.parse(res.body);
    assert.deepEqual(
      projects.map((p: { name: string; kind: string; runCount: number; lastRunId: number }) => [p.name, p.kind, p.runCount, p.lastRunId]),
      [
        ["acme/widget", "repo", 2, 3],
        ["globex/beta", "repo", 1, 1],
      ],
    );
    // The engine was asked for the UNPAGED list — the full history, not one page.
    assert.ok(hub.hits.includes("GET /_apis/v1/Message/workflow/runs"));
  } finally {
    await f.close();
    await hub.close();
  }
});

test("handleRequest: /api/local/projects denied for non-loopback without basic auth (403)", async () => {
  const c = capRes();
  await gate.handleRequest(synthReq("10.0.0.4", "/api/local/projects"), c.res, { basicAuth: undefined } as never, noMint);
  assert.equal(c.rec.code, 403);
});
