import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
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

test("join_: normalizes the hub URL and builds the configure argv (vendor copy skipped when present)", async () => {
  const home = freshHome();
  seedRunner(home, "r1");
  let argv: string[] = [];
  let copied = false;
  const code = await runner.join_(
    "http://hub:4949",
    { name: "r1", labels: "self-hosted,Linux,X64", token: "tok" },
    {
      ensure: async () => 0,
      copyVendor: async () => {
        copied = true;
      },
      run: async (_cmd, args) => {
        argv = args;
        return 0;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(copied, false, "existing listener -> no re-copy");
  assert.ok(argv.includes("configure") && argv.includes("--unattended") && argv.includes("--replace"));
  const url = argv[argv.indexOf("--url") + 1];
  assert.equal(url, "http://hub:4949/runner/server");
  assert.equal(argv[argv.indexOf("--token") + 1], "tok");
  assert.equal(argv[argv.indexOf("--name") + 1], "r1");
  assert.equal(argv[argv.indexOf("--labels") + 1], "self-hosted,Linux,X64");
  assert.equal(argv[argv.indexOf("--work") + 1], "_work");
});

test("join_: a trailing slash on the hub URL is handled the same way", async () => {
  const home = freshHome();
  seedRunner(home, "r2");
  let url = "";
  await runner.join_(
    "http://hub:4949/",
    { name: "r2", labels: "l", token: "t" },
    { ensure: async () => 0, run: async (_c, a) => ((url = a[a.indexOf("--url") + 1]), 0) },
  );
  assert.equal(url, "http://hub:4949/runner/server");
});

test("join_: copies the vendor bundle when the listener is missing, and surfaces a failure code", async () => {
  const home = freshHome();
  let copied = false;
  const code = await runner.join_(
    "http://hub:4949",
    { name: "fresh", labels: "l", token: "t" },
    {
      ensure: async () => 0,
      copyVendor: async (dir) => {
        copied = true;
        const exe = runner.listenerExe(dir);
        mkdirSync(join(exe, ".."), { recursive: true });
        writeFileSync(exe, "x");
      },
      run: async () => 4,
    },
  );
  assert.equal(copied, true);
  assert.equal(code, 4, "non-zero configure code is returned, join-success logs skipped");
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

test("defaultName / defaultLabels reflect host, platform and arch", () => {
  assert.equal(runner.defaultName(), `${hostname()}-ndh`);
  assert.equal(withPlatform("darwin", "arm64", runner.defaultLabels), "self-hosted,macOS,ARM64");
  assert.equal(withPlatform("win32", "x64", runner.defaultLabels), "self-hosted,Windows,X64");
  assert.equal(withPlatform("linux", "arm64", runner.defaultLabels), "self-hosted,Linux,ARM64");
});
