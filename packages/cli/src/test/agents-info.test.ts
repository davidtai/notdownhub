import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getAgentsInfo } from "../agents-info.js";
import { freshHome, startServer, type Fixture } from "./helpers.js";

/** Build a minimal hub.db matching the columns agents-info reads. */
function makeHubDb(home: string): void {
  const dir = join(home, "hub");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "hub.db"));
  db.exec(
    `CREATE TABLE TaskAgentReference(Id INTEGER PRIMARY KEY, Name TEXT, Version TEXT, OSDescription TEXT, Ephemeral INTEGER, MaxParallelism INTEGER);
     CREATE TABLE Agents(Id INTEGER PRIMARY KEY, PoolId INTEGER, TaskAgentId INTEGER);
     CREATE TABLE AgentLabel(Id INTEGER PRIMARY KEY, Name TEXT, Type INTEGER, TaskAgentId INTEGER);
     CREATE TABLE TimeLineRecords(Id TEXT, RecordType TEXT, State INTEGER, WorkerName TEXT);`,
  );
  const agent = db.prepare("INSERT INTO TaskAgentReference(Id,Name,Version,OSDescription,Ephemeral,MaxParallelism) VALUES(?,?,?,?,?,?)");
  agent.run(1, "runner-a", "3.14.0", "Darwin 25.5.0 kernel blah", 0, 2);
  agent.run(2, "runner-b", "3.14.0", "Debian GNU/Linux 12", 1, 1);
  agent.run(3, "runner-c", "3.14.0", "Ubuntu 22.04", 0, 1);
  const link = db.prepare("INSERT INTO Agents(Id,PoolId,TaskAgentId) VALUES(?,?,?)");
  link.run(1, 1, 1);
  link.run(2, 1, 2);
  link.run(3, 1, 3);
  const label = db.prepare("INSERT INTO AgentLabel(Name,Type,TaskAgentId) VALUES(?,?,?)");
  // system (Type 0) + user (Type 1) overlap — must dedupe case-insensitively.
  label.run("self-hosted", 0, 1);
  label.run("macOS", 0, 1);
  label.run("self-hosted", 1, 1);
  label.run("macos", 1, 1);
  label.run("ARM64", 1, 1);
  label.run("linux", 1, 2);
  label.run(null, 0, 2); // a NULL label name must be skipped, not crash
  // runner-a has an in-progress Job record -> busy; others do not.
  const rec = db.prepare("INSERT INTO TimeLineRecords(Id,RecordType,State,WorkerName) VALUES(?,?,?,?)");
  rec.run("t1", "Job", 1, "runner-a");
  rec.run("t2", "Job", 2, "runner-b"); // completed, not busy
  db.close();
}

/** Fake hub answering isagentonline (and AgentPools/Agent for the fallback path). */
async function fakeHub(opts: {
  online?: Set<string>;
  agents?: { id: number; name: string }[];
}): Promise<Fixture> {
  return startServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/_apis/v1/Message/isagentonline") {
      const name = url.searchParams.get("name") ?? "";
      if (opts.online?.has(name)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ online: true }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ online: false }));
      }
      return;
    }
    if (url.pathname === "/_apis/v1/AgentPools") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: [{ id: 1 }] }));
      return;
    }
    if (url.pathname.startsWith("/_apis/v1/Agent/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: opts.agents ?? [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

const noMint = async () => null;

test("getAgentsInfo (DB path): merges labels, liveness and busy into active/idle/offline", async () => {
  const home = freshHome();
  makeHubDb(home);
  const hub = await fakeHub({ online: new Set(["runner-a", "runner-b"]) });
  try {
    const info = await getAgentsInfo(hub.port, noMint);
    const byName = Object.fromEntries(info.map((a) => [a.name, a]));

    assert.equal(info.length, 3);
    // runner-a: online + in-progress job -> active; labels deduped case-insensitively
    assert.equal(byName["runner-a"].state, "active");
    assert.equal(byName["runner-a"].busy, true);
    assert.deepEqual(byName["runner-a"].labels, ["self-hosted", "macOS", "ARM64"]);
    assert.equal(byName["runner-a"].maxParallelism, 2);
    // runner-b: online, no in-progress job -> idle
    assert.equal(byName["runner-b"].state, "idle");
    assert.equal(byName["runner-b"].ephemeral, true);
    assert.deepEqual(byName["runner-b"].labels, ["linux"]);
    // runner-c: offline (isagentonline 404)
    assert.equal(byName["runner-c"].state, "offline");
    assert.equal(byName["runner-c"].online, false);
  } finally {
    await hub.close();
  }
});

test("getAgentsInfo (fallback): no hub DB -> agents from the hub API, no labels, no busy", async () => {
  freshHome(); // no makeHubDb -> readFromDb throws -> API fallback
  const hub = await fakeHub({
    online: new Set(["api-runner"]),
    agents: [{ id: 9, name: "api-runner" }],
  });
  try {
    const info = await getAgentsInfo(hub.port, async () => "jwt");
    assert.equal(info.length, 1);
    assert.equal(info[0].name, "api-runner");
    assert.equal(info[0].state, "idle"); // online, busy unknown -> idle
    assert.deepEqual(info[0].labels, []);
    assert.equal(info[0].busy, false);
  } finally {
    await hub.close();
  }
});

test("getAgentsInfo (fallback): bare-array envelopes, no mint token, ephemeral agent", async () => {
  freshHome(); // no DB -> API fallback
  const hub = await startServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/_apis/v1/AgentPools") return void res.end(JSON.stringify([{ id: 1 }])); // bare array
    if (u.pathname.startsWith("/_apis/v1/Agent/"))
      return void res.end(JSON.stringify([{ id: 7, name: "eph", ephemeral: true }])); // bare array + ephemeral
    if (u.pathname === "/_apis/v1/Message/isagentonline") {
      res.writeHead(200);
      return void res.end(JSON.stringify({ online: false }));
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const info = await getAgentsInfo(hub.port, async () => null); // mint null -> headers {} branch
    assert.equal(info.length, 1);
    assert.equal(info[0].ephemeral, true);
    assert.equal(info[0].state, "offline");
  } finally {
    await hub.close();
  }
});

test("getAgentsInfo (fallback): a dead hub yields an empty list, not a throw", async () => {
  freshHome();
  // point at a port with nothing listening
  const probe = await startServer(() => {});
  const dead = probe.port;
  await probe.close();
  const info = await getAgentsInfo(dead, noMint);
  assert.deepEqual(info, []);
});

test("getAgentsInfo: liveness probe network error counts as offline", async () => {
  const home = freshHome();
  makeHubDb(home);
  // A hub that resets isagentonline connections -> isOnline catch -> offline.
  const hub = await startServer((req, res) => {
    if ((req.url ?? "").includes("isagentonline")) {
      req.destroy();
      return;
    }
    res.writeHead(200);
    res.end("{}");
  });
  try {
    const info = await getAgentsInfo(hub.port, noMint);
    assert.ok(info.every((a) => a.state === "offline"));
  } finally {
    await hub.close();
  }
});

void http;
