import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { startFront, __test as gate } from "../front.js";
import { mergePlaceholders, projectsCmd, type ProjectSummary } from "../projects.js";
import { listPlaceholders, upsertPlaceholder, type ProjectPlaceholder } from "../frontstore.js";
import { freshHome, startServer, type Fixture } from "./helpers.js";

/*
  #113 at the front boundary: the placeholder CRUD route rides the local-only
  UI gate, and /api/local/projects merges placeholders into the aggregate —
  absorbing (and pruning) any placeholder whose slug has real runs.
*/

function req(
  port: number,
  path: string,
  method = "GET",
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json" } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}

async function front(hubPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = startFront({ port: 0, uiDir: null, hubPort });
  await new Promise((r) => server.once("listening", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** Fake engine whose runs list is the single source the aggregate reads. */
async function fakeEngine(runs: unknown[]): Promise<Fixture> {
  return startServer((rq, res) => {
    const u = new URL(rq.url ?? "/", "http://x");
    if (u.pathname === "/_apis/v1/Message/workflow/runs") {
      res.end(JSON.stringify(runs));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

function ph(slug: string): ProjectPlaceholder {
  return {
    slug,
    workflowFileName: "ci.yml",
    workflowName: "CI",
    events: ["push"],
    branches: ["main"],
    runsOn: ["self-hosted"],
    createdAt: 1000,
  };
}

// ── gate ─────────────────────────────────────────────────────────────────────
test("placeholder route: non-loopback without basic auth is denied (403)", async () => {
  const c = capRes();
  await gate.handleRequest(synthReq("10.0.0.9", "/api/local/projects/placeholder", "POST"), c.res, {
    basicAuth: undefined,
  } as never, noMint);
  assert.equal(c.rec.code, 403);
});

// ── CRUD through the real front (loopback) ──────────────────────────────────
test("placeholder route: loopback POST → GET → DELETE roundtrip", async () => {
  freshHome();
  const hub = await fakeEngine([]);
  const f = await front(hub.port);
  try {
    const post = await req(f.port, "/api/local/projects/placeholder", "POST", JSON.stringify({ slug: "acme/new" }));
    assert.equal(post.status, 200);
    const list = await req(f.port, "/api/local/projects/placeholder");
    assert.equal(JSON.parse(list.body)[0].slug, "acme/new");
    const del = await req(f.port, "/api/local/projects/placeholder?slug=acme%2Fnew", "DELETE");
    assert.equal(JSON.parse(del.body).removed, true);
  } finally {
    await f.close();
    await hub.close();
  }
});

// ── merge + absorption ──────────────────────────────────────────────────────
test("GET /api/local/projects: planned placeholder appears with zero runs until a real run absorbs it", async () => {
  const home = freshHome();
  void home;
  const runRow = { id: 7, owner: "acme", repo: "ran", fileName: "ci.yml", displayName: "CI", status: "completed", result: "succeeded" };
  const hub = await fakeEngine([runRow]);
  const f = await front(hub.port);
  try {
    // Two placeholders: one brand new, one whose slug already has a real run.
    await req(f.port, "/api/local/projects/placeholder", "POST", JSON.stringify({ slug: "acme/new", events: ["push"] }));
    await req(f.port, "/api/local/projects/placeholder", "POST", JSON.stringify({ slug: "acme/ran" }));

    const res = await req(f.port, "/api/local/projects");
    assert.equal(res.status, 200);
    const rows = JSON.parse(res.body) as { name: string; kind: string; runCount: number; lastRun: unknown }[];
    // The real project is a repo row; the unseen placeholder is planned; the absorbed one is NOT duplicated.
    assert.deepEqual(rows.map((r) => `${r.name}:${r.kind}`), ["acme/ran:repo", "acme/new:planned"]);
    const planned = rows[1] as { runCount: number; lastRun: unknown; planned?: { events: string[] } };
    assert.equal(planned.runCount, 0);
    assert.equal(planned.lastRun, null);
    assert.deepEqual(planned.planned?.events, ["push"]);

    // Absorption pruned the acme/ran placeholder from the store — permanently.
    const left = await listPlaceholders();
    assert.deepEqual(left.map((p) => p.slug), ["acme/new"]);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("mergePlaceholders: pure — absorbed slugs reported, planned rows sorted after repos", () => {
  const repo: ProjectSummary = {
    name: "acme/ran",
    kind: "repo",
    runCount: 2,
    lastRun: { id: 9 },
    lastRunId: 9,
    workflows: [],
  };
  const { rows, absorbed } = mergePlaceholders([repo], [ph("acme/ran"), ph("acme/new")]);
  assert.deepEqual(absorbed, ["acme/ran"]);
  assert.deepEqual(rows.map((r) => `${r.name}:${r.kind}`), ["acme/ran:repo", "acme/new:planned"]);
  const planned = rows[1];
  assert.equal(planned.runCount, 0);
  assert.equal(planned.lastRunId, null);
});

// ── ndh projects shows planned rows ─────────────────────────────────────────
test("projectsCmd: prefers the hub aggregate and prints planned rows with the [planned] tag", async () => {
  freshHome();
  await upsertPlaceholder(ph("acme/soon"));
  const engine = await fakeEngine([]);
  const f = await front(engine.port);
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const code = await projectsCmd(`http://127.0.0.1:${f.port}`);
    assert.equal(code, 0);
  } finally {
    console.log = orig;
    await f.close();
    await engine.close();
  }
  const out = lines.join("\n");
  assert.match(out, /acme\/soon/);
  assert.match(out, /no runs yet {2}ci\.yml on push/);
  assert.match(out, /\[planned\]/);
});

// ── minimal request/response synthesis for the gate test ────────────────────
const noMint = async () => null;

function synthReq(remote: string, path: string, method = "GET"): http.IncomingMessage {
  return {
    url: path,
    method,
    headers: {},
    socket: { remoteAddress: remote },
    on: () => undefined,
    pipe: () => undefined,
  } as unknown as http.IncomingMessage;
}

function capRes(): { res: http.ServerResponse; rec: { code: number; body: string } } {
  const rec = { code: 0, body: "" };
  const res = {
    writeHead: (code: number) => {
      rec.code = code;
    },
    end: (b?: string) => {
      rec.body = b ?? "";
    },
  } as unknown as http.ServerResponse;
  return { res, rec };
}
