import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { projectsCmd, aggregateProjects, projectKind, serveProjects, type Run } from "../projects.js";
import { openDb, markRunDeleted } from "../joblogs.js";
import { freshHome, startServer } from "./helpers.js";

function capture(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  return { logs, restore: () => (console.log = orig) };
}

type Routes = Record<string, unknown>;
async function hubServing(routes: Routes, onRequest?: (url: string) => void) {
  return startServer((req, res) => {
    onRequest?.(req.url ?? "");
    const path = (req.url ?? "").replace(/\?.*$/, "").replace(/^\//, "");
    if (!(path in routes)) {
      res.writeHead(500);
      res.end("no route");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(routes[path]));
  });
}

// ── projectKind ───────────────────────────────────────────────────────────────
test("projectKind: classifies repo / local slug / unattributed shapes", () => {
  assert.equal(projectKind({ owner: "acme", repo: "alpha" }), "repo");
  assert.equal(projectKind({ owner: "local", repo: "scratch" }), "local");
  assert.equal(projectKind({ owner: "Unknown", repo: "Unknown" }), "unattributed");
  assert.equal(projectKind({ owner: "acme", repo: "Unknown" }), "unattributed");
  assert.equal(projectKind({}), "unattributed");
  assert.equal(projectKind({ owner: "acme" }), "unattributed");
  assert.equal(projectKind({ repo: "alpha" }), "unattributed");
});

// ── aggregateProjects ─────────────────────────────────────────────────────────
/** Build a run list large enough that any single 30-run page misses whole projects. */
function bigHistory(): Run[] {
  const runs: Run[] = [];
  let id = 0;
  const push = (owner: string, repo: string, fileName: string, displayName: string) =>
    runs.push({ id: ++id, owner, repo, fileName, displayName, status: "completed", result: "succeeded" });
  // Old history first (low ids): projects that would vanish from page 0 (newest 30).
  for (let i = 0; i < 5; i++) push("globex", "beta", ".github/workflows/test.yml", "Test");
  for (let i = 0; i < 3; i++) push("initech", "gamma", ".github/workflows/deploy.yml", "Deploy");
  for (let i = 0; i < 2; i++) push("local", "scratch", ".github/workflows/ci.yml", "CI");
  push("Unknown", "Unknown", ".github/workflows/old.yml", "Old");
  // Then 40 recent acme/alpha runs across two workflows — page 0 (newest 30) is 100% acme.
  for (let i = 0; i < 25; i++) push("acme", "alpha", ".github/workflows/ci.yml", "CI");
  for (let i = 0; i < 15; i++) push("acme", "alpha", ".github/workflows/lint.yml", "Lint");
  return runs; // 51 runs total, ids 1..51
}

test("aggregateProjects: derives every project from the full history with exact counts", () => {
  const projects = aggregateProjects(bigHistory());
  assert.deepEqual(
    projects.map((p) => [p.name, p.kind, p.runCount, p.lastRunId]),
    [
      // repos alphabetical, then local slugs, then unattributed.
      ["acme/alpha", "repo", 40, 51],
      ["globex/beta", "repo", 5, 5],
      ["initech/gamma", "repo", 3, 8],
      ["local/scratch", "local", 2, 10],
      ["Unknown/Unknown", "unattributed", 1, 11],
    ],
  );
  // Sanity: the newest 30 ids (a page-0 derivation) contain ONLY acme/alpha —
  // the exact failure mode this aggregation exists to prevent.
  const page0 = bigHistory().sort((a, b) => b.id - a.id).slice(0, 30);
  assert.ok(page0.every((r) => r.owner === "acme"));
});

test("aggregateProjects: per-workflow breakdown carries exact counts and the latest run", () => {
  const acme = aggregateProjects(bigHistory())[0];
  assert.deepEqual(
    acme.workflows.map((w) => [w.label, w.fileName, w.runCount, w.latestRunId]),
    [
      ["CI", "ci.yml", 25, 36],
      ["Lint", "lint.yml", 15, 51],
    ],
  );
  assert.equal(acme.lastRun.id, 51);
});

test("aggregateProjects: distinct local slugs and Unknown/Unknown stay separate rows, never merged", () => {
  const projects = aggregateProjects([
    { id: 1, owner: "local", repo: "app" },
    { id: 2, owner: "local", repo: "lib" },
    { id: 3, owner: "Unknown", repo: "Unknown" },
    { id: 4, owner: "local", repo: "app" },
  ]);
  assert.deepEqual(
    projects.map((p) => [p.name, p.kind, p.runCount]),
    [
      ["local/app", "local", 2],
      ["local/lib", "local", 1],
      ["Unknown/Unknown", "unattributed", 1],
    ],
  );
});

test("aggregateProjects: a run with no owner/repo at all lands in an unattributed 'local' row", () => {
  const rows = aggregateProjects([{ id: 1, fileName: "ci.yml" }]);
  assert.equal(rows[0].name, "local");
  assert.equal(rows[0].kind, "unattributed");
});

// ── serveProjects (the /api/local/projects computation) ──────────────────────
/** A ServerResponse stand-in capturing status + body. */
function captureRes(): { out: { status: number; body: string }; res: http.ServerResponse } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return this;
    },
    end(body?: string) {
      out.body = body ?? "";
    },
  } as unknown as http.ServerResponse;
  return { out, res };
}

test("serveProjects: queries the UNPAGED runs list and aggregates the full history", async () => {
  const home = freshHome();
  const seen: string[] = [];
  const hub = await hubServing({ "_apis/v1/Message/workflow/runs": bigHistory() }, (u) => seen.push(u));
  const { out, res } = captureRes();
  try {
    await serveProjects(hub.port, res, join(home, "hub", "joblogs.db"));
  } finally {
    await hub.close();
  }
  assert.equal(out.status, 200);
  // The full-history contract: no page parameter on the engine query.
  assert.deepEqual(seen, ["/_apis/v1/Message/workflow/runs"]);
  const projects = JSON.parse(out.body) as { name: string; runCount: number; lastRunId: number }[];
  assert.deepEqual(
    projects.map((p) => [p.name, p.runCount, p.lastRunId]),
    [
      ["acme/alpha", 40, 51],
      ["globex/beta", 5, 5],
      ["initech/gamma", 3, 8],
      ["local/scratch", 2, 10],
      ["Unknown/Unknown", 1, 11],
    ],
  );
});

test("serveProjects: tombstoned (deleted) runs are excluded from counts and last-run", async () => {
  const home = freshHome();
  const dbPath = join(home, "hub", "joblogs.db");
  const db = await openDb(dbPath);
  markRunDeleted(db, 51); // acme/alpha's newest run
  markRunDeleted(db, 11); // the only Unknown/Unknown run
  db.close();
  const hub = await hubServing({ "_apis/v1/Message/workflow/runs": bigHistory() });
  const { out, res } = captureRes();
  try {
    await serveProjects(hub.port, res, dbPath);
  } finally {
    await hub.close();
  }
  assert.equal(out.status, 200);
  const projects = JSON.parse(out.body) as { name: string; runCount: number; lastRunId: number }[];
  const acme = projects.find((p) => p.name === "acme/alpha")!;
  assert.equal(acme.runCount, 39);
  assert.equal(acme.lastRunId, 50);
  assert.equal(projects.find((p) => p.name === "Unknown/Unknown"), undefined);
});

test("serveProjects: 502 when the engine is down or returns non-OK", async () => {
  const home = freshHome();
  const dbPath = join(home, "hub", "joblogs.db");
  // Engine down: nothing listens on this port.
  const closed = await startServer((_q, r) => r.end());
  const gonePort = closed.port;
  await closed.close();
  const a = captureRes();
  await serveProjects(gonePort, a.res, dbPath);
  assert.equal(a.out.status, 502);

  const bad = await startServer((_q, r) => {
    r.writeHead(500);
    r.end();
  });
  const b = captureRes();
  try {
    await serveProjects(bad.port, b.res, dbPath);
  } finally {
    await bad.close();
  }
  assert.equal(b.out.status, 502);
  assert.match(b.out.body, /500/);
});

// ── projectsCmd ───────────────────────────────────────────────────────────────
test("projectsCmd: derives from the unpaged full history and prints every project", async () => {
  const seen: string[] = [];
  const srv = await hubServing({ "_apis/v1/Message/workflow/runs": bigHistory() }, (u) => seen.push(u));
  const cap = capture();
  try {
    const code = await projectsCmd(srv.url);
    assert.equal(code, 0);
    const out = cap.logs.join("\n");
    assert.deepEqual(seen, ["/_apis/v1/Message/workflow/runs"]); // no ?page= — full history
    assert.match(out, /acme\/alpha\s+40 runs\s+last: #51 Lint completed\/succeeded \(\?\)/);
    assert.match(out, /globex\/beta\s+5 runs/);
    assert.match(out, /initech\/gamma\s+3 runs/);
    assert.match(out, /local\/scratch\s+2 runs.*\[local checkout\]/);
    assert.match(out, /Unknown\/Unknown\s+1 run .*\[unattributed\]/);
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("projectsCmd: reports an empty list when the hub has no runs", async () => {
  const srv = await hubServing({ "_apis/v1/Message/workflow/runs": [] });
  const cap = capture();
  try {
    await projectsCmd(srv.url + "/"); // already trailing-slashed
    assert.match(cap.logs.join("\n"), /\(none yet\)/);
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("projectsCmd: supports the {value:[...]} envelope and field fallbacks", async () => {
  const srv = await hubServing({
    "_apis/v1/Message/workflow/runs": {
      value: [{ id: 9, owner: "acme", repo: "widget" }],
    },
  });
  const cap = capture();
  try {
    await projectsCmd(srv.url);
    // No workflow name → "?", no result → status-only (empty here), no event → "?".
    assert.match(cap.logs.join("\n"), /acme\/widget\s+1 run \s+last: #9 \? {2}\(\?\)/);
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("projectsCmd: a non-OK hub response throws (surfaced as a CLI failure)", async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(503);
    res.end("down");
  });
  try {
    await assert.rejects(() => projectsCmd(srv.url), /workflow\/runs.*503/);
  } finally {
    await srv.close();
  }
});
