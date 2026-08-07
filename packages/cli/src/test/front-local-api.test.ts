import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { startFront, __test as gate } from "../front.js";
import { openDb, JobLogWriter } from "../joblogs.js";
import { freshHome, startServer, type Fixture } from "./helpers.js";

function req(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
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
