import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { __test as runner } from "../runner.js";
import { vendorDir } from "../lib.js";
import { __test as fl } from "../filelog.js";
import { freshHome } from "./helpers.js";

function withPlatform<T>(platform: string, arch: string, fn: () => T): T {
  const p = Object.getOwnPropertyDescriptor(process, "platform")!;
  const a = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", p);
    Object.defineProperty(process, "arch", a);
  }
}

/** Pre-create a runner's listener binary so copyVendor is skipped. Returns its dir. */
function seedRunner(home: string, name: string): string {
  const dir = join(home, "runners", name);
  const exe = runner.listenerExe(dir);
  mkdirSync(join(exe, ".."), { recursive: true });
  writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

test("join_: a fresh join normalizes the hub URL and builds the configure argv", async () => {
  const home = freshHome();
  let argv: string[] = [];
  let copied = false;
  const code = await runner.join_(
    "http://hub:4949",
    { name: "r1", labels: "self-hosted,Linux,X64", token: "tok" },
    {
      ensure: async () => 0,
      copyVendor: async (dir) => {
        copied = true;
        const exe = runner.listenerExe(dir);
        mkdirSync(join(exe, ".."), { recursive: true });
        writeFileSync(exe, "x");
      },
      run: async (_cmd, args) => {
        argv = args;
        return 0;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(copied, true, "fresh join copies the bundle");
  assert.ok(argv.includes("configure") && argv.includes("--unattended") && argv.includes("--replace"));
  const url = argv[argv.indexOf("--url") + 1];
  assert.equal(url, "http://hub:4949/runner/server");
  assert.equal(argv[argv.indexOf("--token") + 1], "tok");
  assert.equal(argv[argv.indexOf("--name") + 1], "r1");
  assert.equal(argv[argv.indexOf("--labels") + 1], "self-hosted,Linux,X64");
  assert.equal(argv[argv.indexOf("--work") + 1], "_work");
  void home;
});

test("join_: a trailing slash on the hub URL is handled the same way", async () => {
  const home = freshHome();
  let url = "";
  await runner.join_(
    "http://hub:4949/",
    { name: "r2", labels: "l", token: "t" },
    {
      ensure: async () => 0,
      copyVendor: async (dir) => {
        const exe = runner.listenerExe(dir);
        mkdirSync(join(exe, ".."), { recursive: true });
        writeFileSync(exe, "x");
      },
      run: async (_c, a) => ((url = a[a.indexOf("--url") + 1]), 0),
    },
  );
  assert.equal(url, "http://hub:4949/runner/server");
  void home;
});

test("join_: joining an EXISTING name WITHOUT --re-join refuses cleanly — no configure, no copy, no unregister", async () => {
  const home = freshHome();
  const dir = seedRunner(home, "taken");
  let configured = false;
  let copied = false;
  let removed = false;
  const code = await runner.join_(
    "http://hub:4949",
    { name: "taken", labels: "l", token: "t" },
    {
      ensure: async () => 0,
      copyVendor: async () => {
        copied = true;
      },
      removeExec: async () => ((removed = true), 0),
      run: async () => ((configured = true), 0),
    },
  );
  assert.equal(code, 1, "refusal is a non-zero exit, not the raw listener error");
  assert.equal(configured, false, "the vendored configure never runs (no raw 'already configured')");
  assert.equal(copied, false);
  assert.equal(removed, false);
  assert.equal(existsSync(runner.listenerExe(dir)), true, "the existing instance is left untouched");
});

test("join_: --re-join unregisters, re-copies the bundle, then configures — in that order", async () => {
  const home = freshHome();
  const dir = seedRunner(home, "reup");
  const order: string[] = [];
  const code = await runner.join_(
    "http://hub:4949",
    { name: "reup", labels: "l", token: "tok", reJoin: true },
    {
      ensure: async () => 0,
      findListener: async () => [],
      removeExec: async (d, t) => {
        order.push("remove");
        assert.equal(d, dir);
        assert.equal(t, "tok");
        return 0;
      },
      copyVendor: async (d) => {
        order.push("copy");
        const exe = runner.listenerExe(d);
        mkdirSync(join(exe, ".."), { recursive: true });
        writeFileSync(exe, "fresh");
      },
      run: async (_c, args) => {
        order.push("configure");
        assert.ok(args.includes("--replace"));
        return 0;
      },
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(order, ["remove", "copy", "configure"], "unregister -> re-copy -> configure");
  assert.equal(existsSync(runner.listenerExe(dir)), true, "instance is joined after re-join");
});

test("join_: --re-join with the hub down warns on the failed unregister but still refreshes and re-configures", async () => {
  const home = freshHome();
  const dir = seedRunner(home, "hubgone");
  let copied = false;
  let configured = false;
  const code = await runner.join_(
    "http://hub:4949",
    { name: "hubgone", labels: "l", token: "t", reJoin: true },
    {
      ensure: async () => 0,
      findListener: async () => [],
      removeExec: async () => 1, // hub unreachable -> non-zero, tolerated
      copyVendor: async (d) => {
        copied = true;
        const exe = runner.listenerExe(d);
        mkdirSync(join(exe, ".."), { recursive: true });
        writeFileSync(exe, "fresh");
      },
      run: async () => ((configured = true), 0),
    },
  );
  assert.equal(code, 0, "re-join still succeeds locally when the old hub is unreachable");
  assert.equal(copied, true, "binaries are refreshed even though unregister failed");
  assert.equal(configured, true);
  assert.equal(existsSync(runner.listenerExe(dir)), true);
});

test("join_: --re-join whose configure fails AFTER the remove cleans up — the instance does not pretend to be joined", async () => {
  const home = freshHome();
  const dir = seedRunner(home, "broken");
  const code = await runner.join_(
    "http://hub:4949",
    { name: "broken", labels: "l", token: "t", reJoin: true },
    {
      ensure: async () => 0,
      findListener: async () => [],
      removeExec: async () => 0,
      copyVendor: async (d) => {
        const exe = runner.listenerExe(d);
        mkdirSync(join(exe, ".."), { recursive: true });
        writeFileSync(exe, "fresh");
      },
      run: async () => 5, // configure fails after we already removed the old instance
    },
  );
  assert.equal(code, 5, "the configure exit code is surfaced");
  assert.equal(existsSync(dir), false, "half-state cleaned up: dir gone, so list/start won't see a joined runner");
});

test("join_: --re-join preserves the stored hub certificate across the teardown", async () => {
  const home = freshHome();
  const dir = seedRunner(home, "tls");
  const caFile = join(dir, "ca.pem");
  writeFileSync(caFile, "CERT-DATA");
  const code = await runner.join_(
    "http://hub:4949",
    { name: "tls", labels: "l", token: "t", reJoin: true },
    {
      ensure: async () => 0,
      findListener: async () => [],
      removeExec: async () => 0,
      copyVendor: async (d) => {
        const exe = runner.listenerExe(d);
        mkdirSync(join(exe, ".."), { recursive: true });
        writeFileSync(exe, "fresh");
      },
      run: async () => 0,
    },
  );
  assert.equal(code, 0);
  assert.equal(existsSync(caFile), true, "ca.pem survives the re-join");
  assert.equal(readFileSync(caFile, "utf8"), "CERT-DATA");
});

test("join_: copies the vendor bundle when the listener is missing, and surfaces + cleans up a failure", async () => {
  const home = freshHome();
  let copied = false;
  let instanceDir = "";
  const code = await runner.join_(
    "http://hub:4949",
    { name: "fresh", labels: "l", token: "t" },
    {
      ensure: async () => 0,
      copyVendor: async (dir) => {
        copied = true;
        instanceDir = dir;
        const exe = runner.listenerExe(dir);
        mkdirSync(join(exe, ".."), { recursive: true });
        writeFileSync(exe, "x");
      },
      run: async () => 4,
    },
  );
  assert.equal(copied, true);
  assert.equal(code, 4, "non-zero configure code is returned, join-success logs skipped");
  assert.equal(existsSync(instanceDir), false, "a failed fresh join leaves nothing that pretends to be joined");
  void home;
});

test("join_: the default copyVendor copies the vendor bundle into <runner>/bin", async () => {
  const home = freshHome();
  const vdir = vendorDir();
  mkdirSync(vdir, { recursive: true });
  writeFileSync(join(vdir, "Runner.Listener"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(vdir, "extra.dll"), "x");
  await runner.join_(
    "http://h:4949",
    { name: "cp1", labels: "l", token: "t" },
    { ensure: async () => 0, run: async () => 0 }, // no copyVendor -> real cp runs
  );
  assert.equal(existsSync(join(home, "runners", "cp1", "bin", "Runner.Listener")), true);
  assert.equal(existsSync(join(home, "runners", "cp1", "bin", "extra.dll")), true);
});

test("start: runs the named runner's listener; auto-selects the sole runner when unnamed", async () => {
  const home = freshHome();
  seedRunner(home, "only");
  let ran: string[] = [];
  const code = await runner.start("only", { run: async (_c, a) => ((ran = a), 0) });
  assert.equal(code, 0);
  assert.deepEqual(ran, ["run"]);

  const auto = await runner.start(undefined, { run: async () => 0 });
  assert.equal(auto, 0);
  fl.reset();
});

test("remove: happy path — no listener running, unregisters via the listener, deletes the instance dir", async () => {
  const home = freshHome();
  const dir = seedRunner(home, "gone");
  let removeArgs: [string, string] | null = null;
  const code = await runner.remove_(
    "gone",
    { token: "tok" },
    {
      findListener: async () => [],
      removeExec: async (d, t) => ((removeArgs = [d, t]), 0),
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(removeArgs, [dir, "tok"]);
  assert.equal(existsSync(dir), false, "instance dir deleted");
});

test("remove: a running listener is SIGTERM'd, then removed and deleted", async () => {
  const home = freshHome();
  const dir = seedRunner(home, "live");
  const signals: Array<[number, string]> = [];
  let calls = 0;
  const code = await runner.remove_(
    "live",
    { token: "t" },
    {
      // Alive on the first probe, gone after the SIGTERM.
      findListener: async () => (calls++ === 0 ? [4242] : []),
      kill: (pid, sig) => signals.push([pid, sig as string]),
      delay: async () => {},
      removeExec: async () => 0,
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
  assert.equal(existsSync(dir), false);
});

test("remove: a listener that ignores SIGTERM is SIGKILL'd after the grace window", async () => {
  const home = freshHome();
  seedRunner(home, "stubborn");
  const signals: string[] = [];
  const code = await runner.remove_(
    "stubborn",
    { token: "t" },
    {
      findListener: async () => [999], // never exits
      kill: (_pid, sig) => signals.push(sig as string),
      delay: async () => {},
      removeExec: async () => 0,
    },
  );
  assert.equal(code, 0);
  assert.equal(signals[0], "SIGTERM");
  assert.ok(signals.includes("SIGKILL"), "escalates to SIGKILL");
});

test("remove: hub unreachable — warns but still deletes the instance dir", async () => {
  const home = freshHome();
  const dir = seedRunner(home, "orphan");
  const code = await runner.remove_(
    "orphan",
    { token: "t" },
    { findListener: async () => [], removeExec: async () => 1 }, // non-zero == hub unreachable
  );
  assert.equal(code, 0, "removal still succeeds locally");
  assert.equal(existsSync(dir), false, "dir deleted even though the hub still lists it");
});

test("remove: --force skips the hub unregister entirely", async () => {
  const home = freshHome();
  const dir = seedRunner(home, "offline");
  let removeCalled = false;
  const code = await runner.remove_(
    "offline",
    { token: "t", force: true },
    { findListener: async () => [], removeExec: async () => ((removeCalled = true), 0) },
  );
  assert.equal(code, 0);
  assert.equal(removeCalled, false, "--force must not invoke the listener remove");
  assert.equal(existsSync(dir), false);
});

test("remove: the default remove-exec really spawns the instance's listener (config.sh remove counterpart)", async () => {
  const home = freshHome();
  // A fake listener that asserts it was called as `remove --token <t>` and exits 0.
  const dir = join(home, "runners", "realexec");
  const exe = runner.listenerExe(dir);
  mkdirSync(join(exe, ".."), { recursive: true });
  writeFileSync(exe, `#!/bin/sh\n[ "$1" = "remove" ] && [ "$2" = "--token" ] && [ "$3" = "sekret" ] || exit 3\nexit 0\n`, {
    mode: 0o755,
  });
  // removeExec is NOT injected -> defaultRemoveExec runs the real subprocess.
  const code = await runner.remove_("realexec", { token: "sekret" }, { findListener: async () => [] });
  assert.equal(code, 0, "listener saw `remove --token sekret` and exited 0");
  assert.equal(existsSync(dir), false, "instance dir deleted after a successful unregister");
});

test("defaultToken: explicit --token wins; else the co-located hub token; else the default", async () => {
  const home = freshHome();
  // No explicit token, no hub file -> the literal default.
  assert.equal(await runner.defaultToken({ token: "notdownhub" }), "notdownhub");
  // Explicit token always wins.
  assert.equal(await runner.defaultToken({ token: "explicit" }), "explicit");
  // A co-located hub's persisted registration token is reused when no explicit token is given.
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(join(home, "hub", "runner-token"), "hubtoken\n");
  assert.equal(await runner.defaultToken({ token: "notdownhub" }), "hubtoken");
});

test("defaultName / defaultLabels reflect host, platform and arch", () => {
  assert.equal(runner.defaultName(), `${hostname()}-ndh`);
  assert.equal(withPlatform("darwin", "arm64", runner.defaultLabels), "self-hosted,macOS,ARM64");
  assert.equal(withPlatform("win32", "x64", runner.defaultLabels), "self-hosted,Windows,X64");
  assert.equal(withPlatform("linux", "arm64", runner.defaultLabels), "self-hosted,Linux,ARM64");
});

// ── runner list (#68) ─────────────────────────────────────────────────────────
function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  return { logs, restore: () => (console.log = orig) };
}

test("join_ records the labels so runner list can show them offline", async () => {
  const home = freshHome();
  const dir = join(home, "runners", "r1");
  const code = await runner.join_(
    "http://hub:4949",
    { name: "r1", labels: "self-hosted,macOS,ARM64,gpu", token: "t" },
    {
      ensure: async () => 0,
      copyVendor: async (d) => {
        const exe = runner.listenerExe(d);
        mkdirSync(join(exe, ".."), { recursive: true });
        writeFileSync(exe, "x");
      },
      run: async () => 0,
    },
  );
  assert.equal(code, 0);
  assert.equal(await runner.readLabels(dir), "self-hosted,macOS,ARM64,gpu");
});

test("runner list (local): shows each instance's labels + running/stopped, under a labeled section", async () => {
  const home = freshHome();
  const aDir = seedRunner(home, "runner-a");
  seedRunner(home, "runner-b");
  writeFileSync(join(aDir, "labels"), "self-hosted,macOS,gpu\n");
  // runner-b has no labels file (e.g. joined before #68) → empty labels.
  const cap = captureLog();
  try {
    const code = await runner.list(
      {},
      { findListener: async (dir) => (dir === aDir ? [111] : []) }, // a running, b stopped
    );
    assert.equal(code, 0);
    const out = cap.logs.join("\n");
    assert.match(out, /local runner instances:/);
    assert.match(out, /runner-a {2}\[self-hosted,macOS,gpu\] {2}running/);
    assert.match(out, /runner-b {2}\[\] {2}stopped/);
  } finally {
    cap.restore();
  }
});

test("runner list (local): none joined prints a helpful empty line", async () => {
  freshHome();
  const cap = captureLog();
  try {
    assert.equal(await runner.list({}, {}), 0);
    assert.match(cap.logs.join("\n"), /local runner instances:\n {2}\(none joined/);
  } finally {
    cap.restore();
  }
});

test("runner list --server: shows the hub fleet with labels + live state (rich)", async () => {
  freshHome();
  const cap = captureLog();
  try {
    const code = await runner.list(
      { server: "http://127.0.0.1:6099" },
      {
        fleet: async () => ({
          rich: true,
          agents: [
            { name: "runner-a", labels: ["self-hosted", "gpu"], online: true, busy: true, state: "active", ephemeral: false },
            { name: "runner-b", labels: ["self-hosted"], online: false, busy: false, state: "offline", ephemeral: false },
          ],
        }),
      },
    );
    assert.equal(code, 0);
    const out = cap.logs.join("\n");
    assert.match(out, /fleet @ http:\/\/127\.0\.0\.1:6099:/);
    assert.match(out, /runner-a {2}\[self-hosted,gpu\] {2}online, busy/);
    assert.match(out, /runner-b {2}\[self-hosted\] {2}offline/);
  } finally {
    cap.restore();
  }
});

test("runner list --server: names-only fallback when the fleet is not rich", async () => {
  freshHome();
  const cap = captureLog();
  try {
    await runner.list(
      { server: "http://hub.tailnet:4949" },
      { fleet: async () => ({ rich: false, agents: [{ name: "r1", labels: ["self-hosted"], online: false, busy: false, state: "offline", ephemeral: false }] }) },
    );
    const out = cap.logs.join("\n");
    assert.match(out, /r1 {2}\[self-hosted\]/);
    assert.doesNotMatch(out, /online|offline/);
  } finally {
    cap.restore();
  }
});

test("runner list --server: an unreachable hub prints the [ndh] line and exits 1 (#69 parity)", async () => {
  freshHome();
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  try {
    const code = await runner.list(
      { server: "http://127.0.0.1:6099" },
      {
        fleet: async () => {
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
        },
      },
    );
    assert.equal(code, 1);
    assert.match(errs.join("\n"), /can't reach the hub at http:\/\/127\.0\.0\.1:6099/);
  } finally {
    console.error = orig;
  }
});
