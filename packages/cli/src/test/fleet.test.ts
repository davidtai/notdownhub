import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { getFleet, getRunMeta, isLoopbackUrl, stateLabel } from "../fleet.js";
import { readRunMeta } from "../agents-info.js";
import type { AgentInfo, RunMeta } from "../agents-info.js";
import { connErrorCode } from "../lib.js";
import { freshHome } from "./helpers.js";

test("isLoopbackUrl: localhost / 127.0.0.1 / ::1 are local; a LAN/DNS host is not", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:6099"), true);
  assert.equal(isLoopbackUrl("http://localhost:4949"), true);
  assert.equal(isLoopbackUrl("http://[::1]:4949"), true);
  assert.equal(isLoopbackUrl("http://192.168.1.5:4949"), false);
  assert.equal(isLoopbackUrl("https://hub.tailnet:4949"), false);
  assert.equal(isLoopbackUrl("not a url"), false);
});

test("stateLabel: maps agent state to a human string", () => {
  assert.equal(stateLabel({ state: "active" }), "online, busy");
  assert.equal(stateLabel({ state: "idle" }), "online, idle");
  assert.equal(stateLabel({ state: "offline" }), "offline");
});

test("getFleet: co-located loopback reads the rich shape via getAgentsInfo + management JWT", async () => {
  let mintedPort = 0;
  let tokenSeen: string | undefined;
  const rich: AgentInfo[] = [
    { name: "runner-a", labels: ["self-hosted", "gpu"], online: true, busy: false, state: "idle", ephemeral: false },
  ];
  const fleet = await getFleet("http://127.0.0.1:6099", {
    isLoopback: () => true,
    localHub: async () => ({ hubPort: 6100, runnerToken: "tok" }),
    mkMint: (port, token) => {
      mintedPort = port;
      tokenSeen = token;
      return async () => "jwt";
    },
    agentsInfo: async (port, mint) => {
      assert.equal(port, 6100);
      assert.equal(await mint(), "jwt");
      return rich;
    },
  });
  assert.equal(fleet.rich, true);
  assert.deepEqual(fleet.agents, rich);
  assert.equal(mintedPort, 6100);
  assert.equal(tokenSeen, "tok");
});

test("getFleet: a remote hub falls back to the proxied _apis (names + labels, no live state)", async () => {
  const routes: Record<string, unknown> = {
    "/_apis/v1/AgentPools": [{ id: 1 }],
    "/_apis/v1/Agent/1": { value: [{ name: "r1", labels: [{ name: "self-hosted" }, { name: "X64" }, {}] }, { name: "r2", labels: [] }, {}] },
  };
  const fleet = await getFleet("http://hub.tailnet:4949", {
    isLoopback: () => false,
    getJson: async (url) => routes[new URL(url).pathname] ?? [],
  });
  assert.equal(fleet.rich, false);
  assert.equal(fleet.agents.length, 2); // the nameless entry is dropped
  assert.deepEqual(fleet.agents[0].labels, ["self-hosted", "X64"]);
  assert.equal(fleet.agents[0].state, "offline");
});

test("getFleet: loopback but no local hub running → fallback (not the rich path)", async () => {
  let fell = false;
  const fleet = await getFleet("http://127.0.0.1:6099", {
    isLoopback: () => true,
    localHub: async () => null,
    getJson: async () => {
      fell = true;
      return [];
    },
  });
  assert.equal(fleet.rich, false);
  assert.ok(fell, "should have used the proxied fallback");
});

test("getFleet: a connection failure in the fallback propagates, still classifiable (for #69)", async () => {
  let thrown: unknown;
  try {
    await getFleet("http://hub:4949", {
      isLoopback: () => false,
      getJson: async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      },
    });
    assert.fail("should have thrown");
  } catch (err) {
    thrown = err;
  }
  assert.equal(connErrorCode(thrown), "ECONNREFUSED"); // the caller can still translate it (#69)
});

test("getRunMeta: only reads the local DB for a co-located hub; empty otherwise", async () => {
  const meta = new Map<number, RunMeta>([[1, { runners: ["r"] }]]);
  // remote → empty
  assert.equal((await getRunMeta("http://hub:4949", { isLoopback: () => false })).size, 0);
  // loopback but no local hub → empty
  assert.equal((await getRunMeta("http://127.0.0.1:6099", { isLoopback: () => true, localHub: async () => null })).size, 0);
  // co-located → the DB reader result
  const got = await getRunMeta("http://127.0.0.1:6099", {
    isLoopback: () => true,
    localHub: async () => ({ hubPort: 6100 }),
    runMeta: async () => meta,
  });
  assert.equal(got.size, 1);
  assert.deepEqual(got.get(1), { runners: ["r"] });
});

// ── readRunMeta against a minimal hub.db fixture ──────────────────────────────
async function seedHubDb(path: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE Jobs (JobId TEXT, TimeLineId TEXT, runid INTEGER)`);
  db.exec(`CREATE TABLE TimeLineRecords (Id TEXT, TimelineId TEXT, RecordType TEXT, WorkerName TEXT, StartTime TEXT, FinishTime TEXT)`);
  // run 2: one job on runner-a (a real, finished run)
  db.exec(`INSERT INTO Jobs VALUES ('j2','TL2',2)`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r2','TL2','Job','runner-a','2026-08-07 06:42:34.833163','2026-08-07 06:42:38.933163')`);
  // run 3: two matrix legs across two runners (duration spans both)
  db.exec(`INSERT INTO Jobs VALUES ('j3a','TL3A',3)`);
  db.exec(`INSERT INTO Jobs VALUES ('j3b','TL3B',3)`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r3a','TL3A','Job','runner-a','2026-08-07 07:00:00.000000','2026-08-07 07:00:02.000000')`);
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r3b','TL3B','Job','runner-b','2026-08-07 07:00:01.000000','2026-08-07 07:00:05.000000')`);
  // a non-Job record must be ignored
  db.exec(`INSERT INTO TimeLineRecords VALUES ('r3s','TL3A','Task','runner-a','2026-08-07 07:00:00.500000','2026-08-07 07:00:01.500000')`);
  db.close();
}

test("readRunMeta: derives runner(s), start/finish and duration from Job timeline records", async () => {
  const home = freshHome();
  const dbPath = join(home, "hub.db");
  await seedHubDb(dbPath);
  const meta = await readRunMeta(dbPath);

  const m2 = meta.get(2)!;
  assert.deepEqual(m2.runners, ["runner-a"]);
  assert.equal(m2.startedAt, "2026-08-07 06:42:34.833163");
  assert.equal(m2.finishedAt, "2026-08-07 06:42:38.933163");
  assert.equal(m2.durationMs, 4100);

  const m3 = meta.get(3)!;
  assert.deepEqual(m3.runners.sort(), ["runner-a", "runner-b"]);
  assert.equal(m3.startedAt, "2026-08-07 07:00:00.000000"); // earliest start
  assert.equal(m3.finishedAt, "2026-08-07 07:00:05.000000"); // latest finish
  assert.equal(m3.durationMs, 5000);
});

test("readRunMeta: an unreadable DB degrades to an empty map", async () => {
  assert.equal((await readRunMeta("/no/such/hub.db")).size, 0);
});
