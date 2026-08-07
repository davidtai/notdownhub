import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type AddressInfo, type Server } from "node:net";
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
  // GitServerUrl (github.server_url / GITHUB_SERVER_URL for jobs) points at this hub on a `.localhost`
  // host: it keeps the front's port, so the printed artifact URL resolves, while `.localhost` keeps
  // actions/upload-artifact from treating the hub as GHES and refusing v4 uploads.
  assert.equal(plan.env["Runner.Server__GitServerUrl"], "http://ndh.localhost:4949");
  // token persisted to disk
  assert.equal(readFileSync(join(home, "hub", "runner-token"), "utf8").trim(), plan.token);
});

test("prepareHub: GitServerUrl elides the default port and follows --tls scheme", async () => {
  freshHome();
  const plain = await prepareHub(opts({ port: "80", host: "h" }));
  assert.equal(plain.env["Runner.Server__GitServerUrl"], "http://ndh.localhost");
  const tls = await prepareHub(opts({ tls: true, port: "443", host: "h" }));
  assert.equal(tls.env["Runner.Server__GitServerUrl"], "https://ndh.localhost");
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
  pid = 4242;
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
    portFree: async () => true,
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
    githubToken: undefined,
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

test("hubUp: flipped options (tls, no-auth, no-mirror, basic-auth) exercise the other log branches", async () => {
  freshHome();
  const child = new FakeChild();
  let frontOpts: { tls?: unknown; basicAuth?: unknown; runnerToken?: unknown } = {};
  const code = await hub.hubUp(
    opts({ host: "h", tls: true, auth: false, mirrorRewrite: false, basicAuth: "u:p" }),
    {
      ensure: async () => 0,
      portFree: async () => true,
      spawn: () => child as never,
      startFront: (o) => {
        frontOpts = o as typeof frontOpts;
        return null;
      },
      startTee: () => ({ stop() {} }),
      onSignal: () => {},
      exit: () => {},
      block: async () => 0,
    },
  );
  assert.equal(code, 0);
  // tls resolved (self-signed), auth off → no token, basic-auth parsed
  assert.ok(frontOpts.tls, "tls material present");
  assert.equal(frontOpts.runnerToken, undefined, "no-auth → no registration token");
  assert.equal(frontOpts.basicAuth, "u:p");
  fl.reset();
});

test("hubUp: uses the real signal/exit wiring when those deps are omitted", async () => {
  freshHome();
  const child = new FakeChild();
  const code = await hub.hubUp(opts({ host: "h" }), {
    ensure: async () => 0,
    portFree: async () => true,
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
  assert.equal(typeof hub.hubDown, "function");
  assert.equal(typeof hub.detectLanIp, "function");
  hub.detectLanIp();
  void dirname(fileURLToPath(import.meta.url));
});

class FakeServer extends EventEmitter {}

/** Capture console.error (what log()/the pre-flight line write) for one test. */
function captureErr() {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  return { text: () => lines.join("\n"), restore: () => (console.error = orig) };
}

test("hubUp: #82 — a non-ndh holder on the public port reports 'in use by another process', not hub down", async () => {
  freshHome(); // no pid file → the port holder is not our hub
  let spawned = false;
  const cap = captureErr();
  const code = await hub.hubUp(opts({ host: "h" }), {
    ensure: async () => 0,
    portFree: async (p) => p !== 4949, // public port taken by something else
    spawn: () => {
      spawned = true;
      return new FakeChild() as never;
    },
    startFront: () => null,
    startTee: () => ({ stop() {} }),
    block: async () => 0,
  });
  cap.restore();
  assert.equal(code, 1);
  assert.equal(spawned, false, "nothing spawned when a port is busy");
  assert.match(cap.text(), /:4949 is in use by another process — free it or pass --port/);
  assert.doesNotMatch(cap.text(), /hub down/); // must NOT suggest the dangerous / useless remedy
  fl.reset();
});

test("hubUp: #82 — a non-ndh holder on the internal hub port also reports 'in use by another process'", async () => {
  freshHome();
  let spawned = false;
  const cap = captureErr();
  const code = await hub.hubUp(opts({ host: "h" }), {
    ensure: async () => 0,
    portFree: async (p) => p !== 4950, // internal port taken by something else
    spawn: () => {
      spawned = true;
      return new FakeChild() as never;
    },
    startFront: () => null,
    startTee: () => ({ stop() {} }),
    block: async () => 0,
  });
  cap.restore();
  assert.equal(code, 1);
  assert.equal(spawned, false);
  assert.match(cap.text(), /:4950 is in use by another process/);
  fl.reset();
});

test("hubUp: pre-flight says 'a hub is already running' only when our own verified hub holds the port", async () => {
  freshHome();
  let spawned = false;
  const cap = captureErr();
  const code = await hub.hubUp(opts({ host: "h" }), {
    ensure: async () => 0,
    portFree: async (p) => p !== 4949, // our own hub is on 4949
    // Pid file records a hub on 4949/4950; its front pid is live with a matching identity.
    readPid: () => ({ frontPid: 111, childPid: 222, port: 4949, hubPort: 4950, identity: { "111": "sig-111" } }),
    psProbe: (pid) => (pid === 111 ? "sig-111" : null),
    spawn: () => {
      spawned = true;
      return new FakeChild() as never;
    },
    startFront: () => null,
    startTee: () => ({ stop() {} }),
    block: async () => 0,
  });
  cap.restore();
  assert.equal(code, 1);
  assert.equal(spawned, false);
  assert.match(cap.text(), /a hub is already running on :4949 — run 'ndh hub down' first \(or pass --port\)/);
  fl.reset();
});

test("hubUp: writes the pid file (with per-pid identity) once the front is listening", async () => {
  const home = freshHome();
  const child = new FakeChild();
  child.pid = 9999;
  const server = new FakeServer();
  await hub.hubUp(opts({ host: "h" }), {
    ensure: async () => 0,
    portFree: async () => true,
    // Deterministic identity so we do not depend on a real `ps` for these two pids.
    psProbe: (pid) => `SIG-${pid}`,
    spawn: () => child as never,
    startFront: () => server,
    startTee: () => ({ stop() {} }),
    onSignal: () => {},
    exit: () => {},
    block: async () => 0,
  });
  server.emit("listening");
  const rec = JSON.parse(readFileSync(join(home, "hub", "hub.pid"), "utf8"));
  assert.equal(rec.frontPid, process.pid);
  assert.equal(rec.childPid, 9999);
  assert.equal(rec.port, 4949);
  assert.equal(rec.hubPort, 4950);
  // The signature `hub down` verifies against is captured for BOTH pids at write time.
  assert.equal(rec.identity[String(process.pid)], `SIG-${process.pid}`);
  assert.equal(rec.identity["9999"], "SIG-9999");
  fl.reset();
});

test("hubUp: a front bind error SIGKILLs the child (no orphan), drops the pid, exits 1", async () => {
  freshHome();
  const child = new FakeChild();
  const server = new FakeServer();
  const exits: number[] = [];
  const cap = captureErr();
  await hub.hubUp(opts({ host: "h" }), {
    ensure: async () => 0,
    portFree: async () => true,
    spawn: () => child as never,
    startFront: () => server,
    startTee: () => ({ stop() {} }),
    onSignal: () => {},
    exit: (n) => exits.push(n),
    block: async () => 0,
  });
  server.emit("error", new Error("EADDRINUSE :4949"));
  cap.restore();
  assert.deepEqual(child.killed, ["SIGKILL"], "child killed, not orphaned");
  assert.deepEqual(exits, [1]);
  assert.match(cap.text(), /could not start the hub front on :4949/);
  fl.reset();
});

test("hubDown: no pid file → 'no hub running', exit 0", async () => {
  freshHome();
  const cap = captureErr();
  const code = await hub.hubDown();
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.text(), /no hub running/);
});

test("hubDown: malformed / partial pid files are treated as no hub running", async () => {
  const home = freshHome();
  mkdirSync(join(home, "hub"), { recursive: true });
  const pidFile = join(home, "hub", "hub.pid");

  writeFileSync(pidFile, "{ not json");
  let cap = captureErr();
  assert.equal(await hub.hubDown(), 0);
  cap.restore();

  writeFileSync(pidFile, JSON.stringify({ frontPid: 1 })); // valid JSON, missing fields
  cap = captureErr();
  assert.equal(await hub.hubDown(), 0);
  cap.restore();
});

// A pid file whose recorded identity matches what the fake probe reports for the same pids.
const REC = { frontPid: 111, childPid: 222, port: 5999, hubPort: 6000, identity: { "111": "sig-111", "222": "sig-222" } };
/** Fake `ps`: report each pid's live signature from a map; a missing pid is "gone" (null). */
function fakeProbe(live: Record<number, string>) {
  return (pid: number) => live[pid] ?? null;
}

test("hubDown: reads a real pid file (default reader), signals both, verifies ports, removes it", async () => {
  const home = freshHome();
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(join(home, "hub", "hub.pid"), JSON.stringify(REC));
  const killed: [number, string][] = [];
  let removed = false;
  const cap = captureErr();
  const code = await hub.hubDown({
    // readPid omitted → exercises the default readPidFile success path.
    // Match before SIGTERM, then report both gone so the SIGKILL escalation is skipped.
    psProbe: (pid) => (killed.length === 0 ? `sig-${pid}` : null),
    kill: (pid, sig) => killed.push([pid, sig]),
    removePid: () => (removed = true),
    portFree: async () => true,
    sleep: async () => {},
  });
  cap.restore();
  assert.equal(code, 0);
  assert.deepEqual(killed, [
    [111, "SIGTERM"],
    [222, "SIGTERM"],
  ]);
  assert.equal(removed, true);
  assert.match(cap.text(), /:5999 is free/);
  assert.match(cap.text(), /hub stopped/);
});

test("hubDown: escalates to SIGKILL when a matched process ignores SIGTERM, warns if a port lingers", async () => {
  freshHome();
  const killed: [number, string][] = [];
  const cap = captureErr();
  const code = await hub.hubDown({
    readPid: () => REC,
    psProbe: fakeProbe({ 111: "sig-111", 222: "sig-222" }), // stay alive with matching identity throughout
    kill: (pid, sig) => killed.push([pid, sig]),
    removePid: () => {},
    portFree: async () => false, // ports stay busy → warning branch
    sleep: async () => {},
  });
  cap.restore();
  assert.equal(code, 0);
  assert.deepEqual(killed, [
    [111, "SIGTERM"],
    [222, "SIGTERM"],
    [111, "SIGKILL"],
    [222, "SIGKILL"],
  ]);
  assert.match(cap.text(), /warning: :5999 is still in use/);
});

test("hubDown: #79 — a reused pid (same number, different identity) is NEVER signalled, only reported", async () => {
  freshHome();
  const cap = captureErr();
  const code = await hub.hubDown({
    readPid: () => REC,
    // Both pids are alive, but the OS reused them: their live signatures differ from the recorded ones.
    psProbe: fakeProbe({ 111: "innocent-sleep", 222: "some-other-daemon" }),
    kill: () => assert.fail("must not signal a pid whose identity does not match"),
    removePid: () => assert.fail("must not clear a pid file whose (busy) ports may belong elsewhere"),
    portFree: async () => false, // the ports are held by the unrelated reusers
    sleep: async () => {},
  });
  cap.restore();
  assert.equal(code, 1);
  assert.match(cap.text(), /refusing to signal hub front \(pid 111\)/);
  assert.match(cap.text(), /refusing to signal Runner\.Server \(pid 222\)/);
  assert.match(cap.text(), /pid reused or unverifiable/);
  assert.match(cap.text(), /stale pid file/);
});

test("hubDown: a legacy pid file with no recorded identity refuses to signal live pids", async () => {
  freshHome();
  const cap = captureErr();
  const code = await hub.hubDown({
    // No `identity` field (written by an older binary, or the exact shape from the #79 repro).
    readPid: () => ({ frontPid: 111, childPid: 222, port: 5999, hubPort: 6000 }),
    psProbe: fakeProbe({ 111: "sig-111", 222: "sig-222" }), // alive, but nothing to verify against
    kill: () => assert.fail("unverifiable pids must not be signalled"),
    portFree: async () => true, // ports free → treated as a clearable stale file
    removePid: () => {},
    sleep: async () => {},
  });
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.text(), /refusing to signal hub front \(pid 111\)/);
  assert.match(cap.text(), /cleared a stale pid file/);
});

test("hubDown: SIGKILL is skipped when a matched pid dies + is reused during the grace window", async () => {
  freshHome();
  const killed: [number, string][] = [];
  let phase = 0; // 0 = before grace (matches), 1 = after grace (reused → mismatch)
  const cap = captureErr();
  const code = await hub.hubDown({
    readPid: () => ({ frontPid: 111, childPid: -1, port: 5999, hubPort: 6000, identity: { "111": "sig-111" } }),
    psProbe: (pid) => (pid === 111 ? (phase === 0 ? "sig-111" : "reused-by-someone-else") : null),
    kill: (pid, sig) => killed.push([pid, sig]),
    removePid: () => {},
    portFree: async () => true,
    sleep: async () => {
      phase = 1; // the pid was reused while we waited out the grace period
    },
  });
  cap.restore();
  assert.equal(code, 0);
  // SIGTERM was sent (it still matched then); SIGKILL is withheld because identity no longer matches.
  assert.deepEqual(killed, [[111, "SIGTERM"]]);
  assert.match(cap.text(), /hub stopped/);
});

test("hubDown: stale pid file (pids gone) with a single busy port refuses (exit 1) and names it", async () => {
  freshHome();
  const cap = captureErr();
  const code = await hub.hubDown({
    readPid: () => REC,
    psProbe: fakeProbe({}), // both recorded pids gone → stale
    portFree: async (p) => p !== 5999, // only the public port lingers
    kill: () => assert.fail("must not kill on a stale pid file"),
    removePid: () => assert.fail("must not clear a stale-but-busy pid file"),
    sleep: async () => {},
  });
  cap.restore();
  assert.equal(code, 1);
  assert.match(cap.text(), /stale pid file/);
  assert.match(cap.text(), /:5999 is still in use/);
});

test("hubDown: stale pid file with both ports busy uses the plural phrasing", async () => {
  freshHome();
  const cap = captureErr();
  const code = await hub.hubDown({
    readPid: () => REC,
    psProbe: fakeProbe({}),
    portFree: async () => false, // both lingering
    sleep: async () => {},
  });
  cap.restore();
  assert.equal(code, 1);
  assert.match(cap.text(), /:5999 and :6000 are still in use/);
});

test("hubDown: stale pid file with free ports clears it, reports no hub running, exit 0", async () => {
  freshHome();
  let removed = false;
  const cap = captureErr();
  const code = await hub.hubDown({
    readPid: () => ({ frontPid: 111, childPid: -1, port: 5999, hubPort: 6000, identity: { "111": "sig-111" } }), // childPid<=0 is filtered out
    psProbe: fakeProbe({}), // gone
    portFree: async () => true,
    removePid: () => (removed = true),
    sleep: async () => {},
  });
  cap.restore();
  assert.equal(code, 0);
  assert.equal(removed, true);
  assert.match(cap.text(), /cleared a stale pid file/);
});

test("classifyTargets: splits recorded pids into matched / mismatched, dropping gone ones", () => {
  const rec = { frontPid: 111, childPid: 222, port: 1, hubPort: 2, identity: { "111": "sig-111", "222": "sig-222" } };
  // 111 matches, 222 is reused (different live signature); a childPid<=0 is filtered before probing.
  const r = hub.classifyTargets(rec, fakeProbe({ 111: "sig-111", 222: "reused" }));
  assert.deepEqual(r.matched, [{ label: "hub front", pid: 111, sig: "sig-111" }]);
  assert.deepEqual(r.mismatched, [{ label: "Runner.Server", pid: 222 }]);
  // Gone pid → neither list.
  const gone = hub.classifyTargets(rec, fakeProbe({ 111: "sig-111" }));
  assert.deepEqual(gone.mismatched, []);
  assert.equal(gone.matched.length, 1);
});

test("defaultPsProbe: returns a signature for this process, null for a gone pid", () => {
  const sig = hub.defaultPsProbe(process.pid);
  assert.ok(sig && sig.length > 0, "our own process has a signature");
  assert.equal(hub.defaultPsProbe(2147483646), null); // no such process
});

test("portFree: false while a port is held, true once released", async () => {
  // Bind all interfaces (0.0.0.0), matching how the front / Runner.Server bind, so the probe
  // (which also binds 0.0.0.0) actually collides — a 127.0.0.1-only bind does not on macOS/BSD.
  const srv = await new Promise<Server>((resolve) => {
    const s = createServer();
    s.listen(0, "0.0.0.0", () => resolve(s));
  });
  const port = (srv.address() as AddressInfo).port;
  assert.equal(await hub.portFree(port), false);
  await new Promise<void>((r) => srv.close(() => r()));
  assert.equal(await hub.portFree(port), true);
});

test("pidAlive: true for this process (and pid 1), false for an unused pid", () => {
  assert.equal(hub.pidAlive(process.pid), true);
  assert.equal(hub.pidAlive(1), true); // exists; signal 0 as non-root → EPERM branch
  assert.equal(hub.pidAlive(2147483646), false);
});
