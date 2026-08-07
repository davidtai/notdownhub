import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, startServer, makeTarGz } from "./helpers.js";
import { VENDOR_VERSION } from "../lib.js";

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "ndh-cli-"));
}

function fileEnv(home: string): NodeJS.ProcessEnv {
  return { NDH_HOME: home, NDH_SECRETS_BACKEND: "file", NDH_BASIC_AUTH: "" };
}

/** Seed a "complete" fake vendor bundle so `run`/`dispatch`/`install` don't hit the network. */
function seedVendor(home: string): void {
  const dir = join(home, "vendor", `runner.server-${VENDOR_VERSION}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".ndh-complete"), `${VENDOR_VERSION}\n`);
  const exe = join(dir, "Runner.Client");
  writeFileSync(exe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(exe, 0o755);
  const server = join(dir, "Runner.Server");
  writeFileSync(server, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(server, 0o755);
}

const nonGit = mkdtempSync(join(tmpdir(), "ndh-nogit-"));

test("no args prints help and exits 2", async () => {
  const r = await runCli([], { env: fileEnv(newHome()), cwd: nonGit });
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /run this repo's workflows/);
});

test("unknown command exits 2", async () => {
  const r = await runCli(["bogus-cmd"], { env: fileEnv(newHome()), cwd: nonGit });
  assert.equal(r.status, 2);
});

test("a missing required argument exits 1", async () => {
  const r = await runCli(["secrets", "get"], { env: fileEnv(newHome()), cwd: nonGit });
  assert.equal(r.status, 1);
});

test("secrets: set/get/list/ls/rm round-trip through the CLI", async () => {
  const home = newHome();
  const env = fileEnv(home);
  assert.equal((await runCli(["secrets", "set", "TOKEN", "--value", "s3cret"], { env, cwd: nonGit })).status, 0);
  const got = await runCli(["secrets", "get", "TOKEN"], { env, cwd: nonGit });
  assert.equal(got.status, 0);
  assert.equal(got.stdout.trim(), "s3cret");

  const list = await runCli(["secrets", "list"], { env, cwd: nonGit });
  assert.match(list.stdout, /global\tTOKEN/);
  const ls = await runCli(["secrets", "ls"], { env, cwd: nonGit });
  assert.match(ls.stdout, /global\tTOKEN/);

  assert.equal((await runCli(["secrets", "rm", "TOKEN"], { env, cwd: nonGit })).status, 0);
  // removing again: still exit 0, but reports "no secret"
  const gone = await runCli(["secrets", "rm", "TOKEN"], { env, cwd: nonGit });
  assert.equal(gone.status, 0);
  assert.match(gone.stderr, /no secret 'TOKEN'/);
  // empty list
  assert.match((await runCli(["secrets", "list"], { env, cwd: nonGit })).stdout, /\(no secrets\)/);
});

test("secrets: bare `secrets` shows help; empty get fails", async () => {
  const env = fileEnv(newHome());
  const help = await runCli(["secrets"], { env, cwd: nonGit });
  assert.equal(help.status, 0);
  assert.match(help.stdout + help.stderr, /store secrets locally/);
  const miss = await runCli(["secrets", "get", "NOPE"], { env, cwd: nonGit });
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /no secret 'NOPE'/);
});

test("secrets set: value from piped stdin (trailing newline stripped)", async () => {
  const home = newHome();
  const env = fileEnv(home);
  const set = await runCli(["secrets", "set", "PIPED"], { env, cwd: nonGit, input: "from-stdin\n" });
  assert.equal(set.status, 0);
  const got = await runCli(["secrets", "get", "PIPED"], { env, cwd: nonGit });
  assert.equal(got.stdout.trim(), "from-stdin");
});

test("secrets set: empty value is rejected (exit 1)", async () => {
  const r = await runCli(["secrets", "set", "EMPTY", "--value", ""], { env: fileEnv(newHome()), cwd: nonGit });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /empty secret value/);
});

test("secrets --repo scoping: explicit slug and current-repo detection", async () => {
  const home = newHome();
  const env = fileEnv(home);
  // explicit slug scope
  await runCli(["secrets", "set", "K", "--repo", "own/proj", "--value", "repoval"], { env, cwd: nonGit });
  const g = await runCli(["secrets", "get", "K", "--repo", "own/proj"], { env, cwd: nonGit });
  assert.equal(g.stdout.trim(), "repoval");
  const filtered = await runCli(["secrets", "list", "--repo", "own/proj"], { env, cwd: nonGit });
  assert.match(filtered.stdout, /own\/proj\tK/);

  // --repo with no value + outside a git repo -> fails
  const noRepo = await runCli(["secrets", "set", "K", "--repo", "--value", "x"], { env, cwd: nonGit });
  assert.equal(noRepo.status, 1);
  assert.match(noRepo.stderr, /not inside a git repo/);

  // --repo with no value + inside a git repo -> detects a slug and stores
  const inGit = await runCli(["secrets", "set", "AUTO", "--repo", "--value", "y"], { env, cwd: process.cwd() });
  assert.equal(inGit.status, 0);
});

test("runner: bare subcommand exits 2; list is empty; start without a runner fails", async () => {
  const env = fileEnv(newHome());
  assert.equal((await runCli(["runner"], { env, cwd: nonGit })).status, 2);
  const list = await runCli(["runner", "list"], { env, cwd: nonGit });
  assert.equal(list.status, 0);
  assert.equal(list.stdout.trim(), "");
  const start = await runCli(["runner", "start"], { env, cwd: nonGit });
  assert.equal(start.status, 1);
  assert.match(start.stderr, /none joined yet/);
  const startMissing = await runCli(["runner", "start", "ghost"], { env, cwd: nonGit });
  assert.equal(startMissing.status, 1);
  assert.match(startMissing.stderr, /not found/);
});

test("runner remove: unknown name exits 1 listing known runners; --force removal is idempotent", async () => {
  const home = newHome();
  const env = fileEnv(home);
  // Seed a real instance dir with a fake listener binary so it is a known runner.
  const dir = join(home, "runners", "box");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "Runner.Listener"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(join(dir, "bin", "Runner.Listener"), 0o755);

  // Unknown name -> exit 1, and the known instance is listed in the hint.
  const unknown = await runCli(["runner", "remove", "ghost"], { env, cwd: nonGit });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no such runner 'ghost'/);
  assert.match(unknown.stderr, /box/);

  // --force removes offline (no hub) and deletes the dir.
  const removed = await runCli(["runner", "remove", "box", "--force"], { env, cwd: nonGit });
  assert.equal(removed.status, 0);
  assert.match(removed.stderr, /removed runner 'box'/);
  assert.equal(existsSync(dir), false);

  // Second remove -> idempotent "no such runner" path, exit 1.
  const again = await runCli(["runner", "remove", "box", "--force"], { env, cwd: nonGit });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /no such runner 'box'/);
  assert.match(again.stderr, /none joined/);
});

test("hub: bare subcommand prints usage and exits 2", async () => {
  const r = await runCli(["hub"], { env: fileEnv(newHome()), cwd: nonGit });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: ndh hub up/);
});

test("`ndh help` prints top-level help and exits 0", async () => {
  const r = await runCli(["help"], { env: fileEnv(newHome()), cwd: nonGit });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Commands:/);
});

test("install --force fails (exit 1) when the fetched bundle lacks Runner.Client", async () => {
  const home = newHome();
  const tgz = join(mkdtempSync(join(tmpdir(), "ndh-badbundle-")), "bad.tgz");
  makeTarGz(tgz, { "README.txt": "no runner client in here" });
  const bytes = readFileSync(tgz);
  const srv = await startServer((_req, res) => {
    res.writeHead(200);
    res.end(bytes);
  });
  try {
    const r = await runCli(["install", "--force"], {
      env: { ...fileEnv(home), NDH_VENDOR_URL: srv.url + "/bad.tgz" },
      cwd: nonGit,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing Runner\.Client/);
  } finally {
    await srv.close();
  }
});

test("install: no-ops when the bundle is already complete", async () => {
  const home = newHome();
  seedVendor(home);
  const r = await runCli(["install"], { env: fileEnv(home), cwd: nonGit });
  assert.equal(r.status, 0);
});

test("run: main() intercepts and passes through to Runner.Client (fake vendor)", async () => {
  const home = newHome();
  seedVendor(home);
  const r = await runCli(["run", "-W", ".github/workflows/ci.yml", "--event", "push"], {
    env: fileEnv(home),
    cwd: nonGit,
  });
  assert.equal(r.status, 0);
});

test("dispatch: requires --server; passes through to a reachable hub (fake vendor)", async () => {
  const home = newHome();
  seedVendor(home);
  const bad = await runCli(["dispatch", "--event", "push"], { env: fileEnv(home), cwd: nonGit });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--server/);
  // A reachable hub (any listening server answers the pre-flight probe) lets the fake vendor run.
  const hub = await startServer((_q, r) => r.end());
  try {
    const ok = await runCli(["dispatch", "--server", hub.url], { env: fileEnv(home), cwd: nonGit });
    assert.equal(ok.status, 0);
  } finally {
    await hub.close();
  }
});

test("dispatch: an unreachable hub prints an [ndh] line and exits 1, no leaked Exception (#69)", async () => {
  const home = newHome();
  seedVendor(home);
  // A server started then closed yields a dead port → connection refused on the probe.
  const dead = await startServer((_q, r) => r.end());
  const url = dead.url;
  await dead.close();
  const r = await runCli(["dispatch", "--server", url, "--event", "push"], { env: fileEnv(home), cwd: nonGit });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[ndh\]/);
  assert.match(r.stderr, /can't reach the hub/);
  assert.doesNotMatch(r.stderr + r.stdout, /Exception:/);
});

test("run: a runtime failure (vendor download refused) surfaces via the top-level handler, exit 1", async () => {
  const home = newHome();
  const r = await runCli(["run", "-W", "x.yml"], {
    env: { ...fileEnv(home), NDH_VENDOR_URL: "http://127.0.0.1:1/nope.tgz" },
    cwd: nonGit,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[ndh\]/);
});

test("status: the CLI action runs against a live hub (exit 0)", async () => {
  const srv = await startServer((req, res) => {
    const path = (req.url ?? "").replace(/\?.*$/, "");
    const routes: Record<string, unknown> = {
      "/_apis/v1/AgentPools": [{ id: 1 }],
      "/_apis/v1/Agent/1": [],
      "/_apis/v1/Message/workflow/runs": [],
    };
    if (!(path in routes)) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(routes[path]));
  });
  try {
    const r = await runCli(["status", "--server", srv.url], { env: fileEnv(newHome()), cwd: nonGit });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /runners:/);
  } finally {
    await srv.close();
  }
});
