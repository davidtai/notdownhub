import { test } from "node:test";
import assert from "node:assert/strict";
import { statusCmd, projectLabel } from "../status.js";
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

test("projectLabel: joins owner/repo, tolerates a missing half, and falls back to local", () => {
  assert.equal(projectLabel({ owner: "acme", repo: "widget" }), "acme/widget");
  assert.equal(projectLabel({ repo: "widget" }), "widget");
  assert.equal(projectLabel({ owner: "acme" }), "acme");
  assert.equal(projectLabel({}), "local");
});

test("statusCmd: prints runners (array shapes) and recent runs with all field fallbacks", async () => {
  const srv = await hubServing({
    "_apis/v1/AgentPools": [{ id: 1 }],
    "_apis/v1/Agent/1": [
      { name: "mac-runner", labels: [{ name: "self-hosted" }, { name: "macOS" }, {}] },
      { name: "linux-runner", labels: [{ name: "self-hosted" }] },
    ],
    "_apis/v1/Message/workflow/runs": [
      { id: 7, displayName: "CI", status: "completed", result: "success", eventName: "push", owner: "acme", repo: "widget" },
      { id: 8, fileName: "release.yml", status: "in_progress" },
      { id: 9 },
    ],
  });
  const cap = capture();
  try {
    const code = await statusCmd(srv.url);
    assert.equal(code, 0);
    const out = cap.logs.join("\n");
    assert.match(out, /mac-runner {2}\[self-hosted,macOS\]/);
    assert.match(out, /linux-runner {2}\[self-hosted\]/);
    // Each recent-runs line now carries its project in [brackets].
    assert.match(out, /#7 {2}CI {2}\[acme\/widget\] {2}completed\/success {2}\(push\)/);
    assert.match(out, /#8 {2}release\.yml {2}\[local\] {2}in_progress {2}\(\?\)/);
    assert.match(out, /#9 {2}\? {2}\[local\]\s+\(\?\)/); // no project recorded → local fallback
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("statusCmd: supports the {value:[...]} envelope and reports empties", async () => {
  const srv = await hubServing({
    "_apis/v1/AgentPools": { value: [{ id: 3 }] },
    "_apis/v1/Agent/3": { value: [] },
    "_apis/v1/Message/workflow/runs": [],
  });
  const cap = capture();
  try {
    await statusCmd(srv.url + "/"); // already trailing-slashed
    const out = cap.logs.join("\n");
    assert.match(out, /\(none registered\)/);
    assert.match(out, /\(no runs yet\)/);
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("statusCmd: tolerates envelope objects that omit `value` entirely", async () => {
  const srv = await hubServing({
    "_apis/v1/AgentPools": { value: [{ id: 5 }] },
    "_apis/v1/Agent/5": {}, // object without a `value` array -> treated as no agents
    "_apis/v1/Message/workflow/runs": [],
  });
  const cap = capture();
  try {
    await statusCmd(srv.url);
    assert.match(cap.logs.join("\n"), /\(none registered\)/);
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("statusCmd: an AgentPools envelope without `value` yields no runners", async () => {
  const srv = await hubServing({
    "_apis/v1/AgentPools": {}, // no value -> empty pool list
    "_apis/v1/Message/workflow/runs": [],
  });
  const cap = capture();
  try {
    await statusCmd(srv.url);
    assert.match(cap.logs.join("\n"), /\(none registered\)/);
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("statusCmd: a non-OK hub response throws (surfaced as a CLI failure)", async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(503);
    res.end("down");
  });
  try {
    await assert.rejects(() => statusCmd(srv.url), /AgentPools: 503/);
  } finally {
    await srv.close();
  }
});

test("statusCmd: an unreachable hub prints one [ndh] line + the underlying error, exits 1 (#69)", async () => {
  // A server we start then immediately close gives us a definitely-dead port.
  const srv = await startServer((_req, res) => res.end());
  const url = srv.url;
  await srv.close();
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  try {
    const code = await statusCmd(url);
    assert.equal(code, 1);
    const out = errs.join("\n");
    assert.match(out, new RegExp(`can't reach the hub at ${url.replace(/[.]/g, "\\.")}`));
    assert.match(out, /ndh hub up/);
    assert.match(out, /ECONNREFUSED/); // underlying error kept for debugging
    assert.doesNotMatch(out, /fetch failed$/m); // the cryptic bare message is gone
  } finally {
    console.error = orig;
  }
});
