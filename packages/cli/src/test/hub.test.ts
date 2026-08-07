import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHub, resolveBasicAuth, __test as hub } from "../hub.js";
import { uiDistDir } from "../front.js";
import { __test as fl } from "../filelog.js";
import { freshHome } from "./helpers.js";

type Opts = Parameters<typeof prepareHub>[0];
function opts(over: Partial<Opts> = {}): Opts {
  return { port: "4949", hubPort: "4950", auth: true, mirrorRewrite: true, ui: false, ...over };
}

test("prepareHub: creates + persists a registration token, assembles env and mirror URLs", async () => {
  const home = freshHome();
  const plan = await prepareHub(opts({ host: "hub.lan", githubToken: "ghp_x" }));
  assert.match(plan.token, /^[0-9a-f]{48}$/);
  assert.equal(plan.host, "hub.lan");
  assert.equal(plan.env["Runner.Server__RUNNER_TOKEN"], plan.token);
  assert.equal(plan.env["Runner.Server__GITHUB_TOKEN"], "ghp_x");
  assert.match(String(plan.env["ConnectionStrings__sqlite"]), /hub\.db/);
  assert.equal(plan.env["Runner.Server__ActionDownloadUrls__0__TarballUrl"], "http://hub.lan:4949/mirror/{0}/tarball/{1}");
  assert.equal(plan.env["Runner.Server__ActionDownloadUrls__0__ZipballUrl"], "http://hub.lan:4949/mirror/{0}/zipball/{1}");
  // token persisted to disk
  assert.equal(readFileSync(join(home, "hub", "runner-token"), "utf8").trim(), plan.token);
});

test("prepareHub: reuses an already-persisted token", async () => {
  freshHome();
  const first = await prepareHub(opts());
  const second = await prepareHub(opts());
  assert.equal(second.token, first.token);
});

test("prepareHub: --no-auth yields no token and no mirror rewrite omits the URLs", async () => {
  freshHome();
  const plan = await prepareHub(opts({ auth: false, mirrorRewrite: false, host: "h" }));
  assert.equal(plan.token, "");
  assert.equal(plan.env["Runner.Server__RUNNER_TOKEN"], undefined);
  assert.equal(plan.env["Runner.Server__ActionDownloadUrls__0__TarballUrl"], undefined);
});

test("prepareHub: host defaults to a detected value when --host absent", async () => {
  freshHome();
  const plan = await prepareHub(opts({ host: undefined }));
  assert.ok(typeof plan.host === "string" && plan.host.length > 0);
});

test("prepareHub: UI dir is null unless opts.ui and it resolves to ui-dist when index.html exists", async () => {
  freshHome();
  // --no-ui always yields null (covers the `candidate` falsy branch)
  assert.equal((await prepareHub(opts({ ui: false }))).uiDir, null);

  // With opts.ui, it resolves to the ui-dist dir iff index.html is present. Ensure it exists so we
  // deterministically cover the positive branch, whether or not the web app was built into ui-dist.
  const dir = uiDistDir();
  const index = join(dir, "index.html");
  const preexisting = existsSync(index);
  if (!preexisting) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(index, "ui");
  }
  try {
    assert.equal((await prepareHub(opts({ ui: true }))).uiDir, dir);
  } finally {
    if (!preexisting) rmSync(index, { force: true });
  }
});

test("resolveBasicAuth: valid passes, malformed is ignored, env is a fallback", () => {
  const saved = process.env.NDH_BASIC_AUTH;
  delete process.env.NDH_BASIC_AUTH;
  assert.equal(resolveBasicAuth("user:pass"), "user:pass");
  assert.equal(resolveBasicAuth("no-colon"), undefined);
  assert.equal(resolveBasicAuth(undefined), undefined);
  process.env.NDH_BASIC_AUTH = "e:e";
  assert.equal(resolveBasicAuth(undefined), "e:e");
  process.env.NDH_BASIC_AUTH = "bad";
  assert.equal(resolveBasicAuth(undefined), undefined);
  if (saved === undefined) delete process.env.NDH_BASIC_AUTH;
  else process.env.NDH_BASIC_AUTH = saved;
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(sig: string) {
    this.killed.push(sig);
  }
}

test("hubUp: spawns Runner.Server, tees its output, wires signals + exit, starts the front, and blocks", async () => {
  const home = freshHome();
  const child = new FakeChild();
  let frontOpts: unknown = null;
  let spawnCmd = "";
  let spawnArgs: string[] = [];
  const signals: { sig: string; fn: () => void }[] = [];
  const exits: number[] = [];

  const code = await hub.hubUp(opts({ host: "h", githubToken: undefined }), {
    ensure: async () => 0,
    spawn: (cmd, args) => {
      spawnCmd = cmd;
      spawnArgs = args;
      return child as never;
    },
    startFront: (o) => {
      frontOpts = o;
      return null;
    },
    startTee: () => ({ stop() {} }),
    onSignal: (sig, fn) => signals.push({ sig, fn }),
    exit: (n) => exits.push(n),
    block: async () => 0,
  });

  assert.equal(code, 0);
  assert.match(spawnCmd, /Runner\.Server$/);
  assert.deepEqual(spawnArgs, ["--urls", "http://*:4950"]);
  assert.deepEqual(frontOpts, {
    port: 4949,
    hubPort: 4950,
    uiDir: null,
    runnerToken: (await prepareHub(opts({ host: "h" }))).token,
    host: "h",
    basicAuth: undefined,
    tls: undefined,
  });

  // child output is teed to the hub log file
  const logPath = join(home, "hub", "logs");
  child.stdout.emit("data", Buffer.from("server stdout line\n"));
  child.stderr.emit("data", Buffer.from("server stderr line\n"));
  await new Promise((r) => setTimeout(r, 30));
  const { readdirSync } = await import("node:fs");
  const logFile = join(logPath, readdirSync(logPath)[0]);
  const logged = readFileSync(logFile, "utf8");
  assert.match(logged, /server stdout line/);
  assert.match(logged, /server stderr line/);

  // signal handlers forward to child.kill
  assert.deepEqual(signals.map((s) => s.sig).sort(), ["SIGINT", "SIGTERM"]);
  signals.forEach((s) => s.fn());
  assert.deepEqual(child.killed.sort(), ["SIGINT", "SIGTERM"]);

  // child exit forwards its code (and defaults null -> 1)
  child.emit("exit", 5);
  child.emit("exit", null);
  assert.deepEqual(exits, [5, 1]);

  fl.reset();
});

test("hubUp: uses the real signal/exit wiring when those deps are omitted", async () => {
  freshHome();
  const child = new FakeChild();
  const code = await hub.hubUp(opts({ host: "h" }), {
    ensure: async () => 0,
    spawn: () => child as never,
    startFront: () => null,
    startTee: () => ({ stop() {} }),
    block: async () => 0,
    // onSignal + exit intentionally omitted -> default (process.on / process.exit) branches taken
  });
  assert.equal(code, 0);
  // remove the two real signal listeners this registered (they close over the fake child)
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const ls = process.listeners(sig);
    if (ls.length) process.removeListener(sig, ls[ls.length - 1] as never);
  }
  fl.reset();
});

test("hubUp exists via __test alongside prepareHub/detectLanIp", () => {
  assert.equal(typeof hub.hubUp, "function");
  assert.equal(typeof hub.prepareHub, "function");
  assert.equal(typeof hub.detectLanIp, "function");
  hub.detectLanIp();
  void dirname(fileURLToPath(import.meta.url));
});
