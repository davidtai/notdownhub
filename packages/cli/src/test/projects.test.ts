import { test } from "node:test";
import assert from "node:assert/strict";
import { projectsCmd, deriveProjectRows } from "../projects.js";
import { startServer } from "./helpers.js";

function capture(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  return { logs, restore: () => (console.log = orig) };
}

type Routes = Record<string, unknown>;
async function hubServing(routes: Routes) {
  return startServer((req, res) => {
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

test("deriveProjectRows: groups by project, counts runs, picks the max-id run as last, sorts by name", () => {
  const rows = deriveProjectRows([
    { id: 3, owner: "acme", repo: "alpha", displayName: "CI" },
    { id: 2, owner: "globex", repo: "beta", displayName: "Test" },
    { id: 1, owner: "acme", repo: "alpha", displayName: "CI" },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.name, r.runCount, r.lastRun.id]),
    [
      ["acme/alpha", 2, 3],
      ["globex/beta", 1, 2],
    ],
  );
});

test("deriveProjectRows: falls back to a 'local' project when a run carries no owner/repo", () => {
  const rows = deriveProjectRows([{ id: 1, fileName: "ci.yml" }]);
  assert.equal(rows[0].name, "local");
});

test("projectsCmd: prints the derived project list with run counts and last run/result", async () => {
  const srv = await hubServing({
    "_apis/v1/Message/workflow/runs": [
      { id: 3, fileName: ".github/workflows/ci.yml", displayName: "CI", status: "completed", result: "succeeded", eventName: "push", owner: "acme", repo: "alpha" },
      { id: 2, fileName: ".github/workflows/test.yml", displayName: "Test", status: "completed", result: "succeeded", eventName: "pull_request", owner: "globex", repo: "beta" },
      { id: 1, fileName: ".github/workflows/ci.yml", displayName: "CI", status: "completed", result: "succeeded", eventName: "push", owner: "acme", repo: "alpha" },
    ],
  });
  const cap = capture();
  try {
    const code = await projectsCmd(srv.url);
    assert.equal(code, 0);
    const out = cap.logs.join("\n");
    assert.match(out, /^projects:/);
    assert.match(out, /acme\/alpha\s+2 runs\s+last: #3 CI completed\/succeeded \(push\)/);
    assert.match(out, /globex\/beta\s+1 run\s+last: #2 Test completed\/succeeded \(pull_request\)/);
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
    assert.match(cap.logs.join("\n"), /acme\/widget\s+1 run\s+last: #9 \? {2}\(\?\)/);
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
