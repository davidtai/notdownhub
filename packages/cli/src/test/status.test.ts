import { test } from "node:test";
import assert from "node:assert/strict";
import { statusCmd } from "../status.js";
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

test("statusCmd: prints runners (array shapes) and recent runs with all field fallbacks", async () => {
  const srv = await hubServing({
    "_apis/v1/AgentPools": [{ id: 1 }],
    "_apis/v1/Agent/1": [
      { name: "mac-runner", labels: [{ name: "self-hosted" }, { name: "macOS" }, {}] },
      { name: "linux-runner", labels: [{ name: "self-hosted" }] },
    ],
    "_apis/v1/Message/workflow/runs": [
      { id: 7, displayName: "CI", status: "completed", result: "success", eventName: "push" },
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
    assert.match(out, /#7 {2}CI {2}completed\/success {2}\(push\)/);
    assert.match(out, /#8 {2}release\.yml {2}in_progress {2}\(\?\)/);
    assert.match(out, /#9 {2}\?\s+\(\?\)/); // empty status/result collapses the spacing
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
