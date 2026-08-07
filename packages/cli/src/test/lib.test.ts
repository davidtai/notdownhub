import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ndhHome,
  vendorDir,
  vendorRid,
  vendorExe,
  exists,
  download,
  extractTarGz,
  run,
  randomToken,
  log,
  humanSize,
  VENDOR_VERSION,
  connErrorCode,
  rootErrorMessage,
  hubUnreachableMessage,
  probeServer,
} from "../lib.js";
import { initFileLog, __test as fl } from "../filelog.js";
import { freshHome, startServer, makeTarGz } from "./helpers.js";

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

test("ndhHome honors NDH_HOME and falls back to ~/.notdownhub", () => {
  const home = freshHome();
  assert.equal(ndhHome(), home);
  assert.ok(vendorDir().startsWith(home));
  assert.ok(vendorDir().includes(VENDOR_VERSION));
  const saved = process.env.NDH_HOME;
  delete process.env.NDH_HOME;
  assert.ok(ndhHome().endsWith(".notdownhub"));
  process.env.NDH_HOME = saved;
});

test("vendorRid maps every supported platform/arch and throws on the rest", () => {
  assert.equal(withPlatform("darwin", "arm64", vendorRid), "osx-arm64");
  assert.equal(withPlatform("darwin", "x64", vendorRid), "osx-x64");
  assert.equal(withPlatform("linux", "arm64", vendorRid), "linux-arm64");
  assert.equal(withPlatform("linux", "x64", vendorRid), "linux-x64");
  assert.equal(withPlatform("win32", "x64", vendorRid), "win-x64");
  assert.throws(() => withPlatform("sunos", "x64", vendorRid), /unsupported platform/);
});

test("vendorExe appends .exe only on win32", () => {
  freshHome();
  assert.ok(withPlatform("win32", "x64", () => vendorExe("Runner.Client")).endsWith("Runner.Client.exe"));
  assert.ok(withPlatform("linux", "x64", () => vendorExe("Runner.Client")).endsWith("Runner.Client"));
});

test("exists reports presence", async () => {
  const home = freshHome();
  assert.equal(await exists(home), true);
  assert.equal(await exists(join(home, "nope")), false);
});

test("download streams a 200 body to disk (atomic rename)", async () => {
  const home = freshHome();
  const srv = await startServer((_req, res) => {
    res.writeHead(200);
    res.end("payload-bytes");
  });
  try {
    const dest = join(home, "out.bin");
    await download(srv.url + "/file", dest);
    assert.equal(readFileSync(dest, "utf8"), "payload-bytes");
    assert.equal(existsSync(dest + ".partial"), false, "partial should be renamed away");
  } finally {
    await srv.close();
  }
});

test("download throws on a non-2xx response", async () => {
  const home = freshHome();
  const srv = await startServer((_req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  try {
    await assert.rejects(() => download(srv.url + "/missing", join(home, "x")), /download failed: 404/);
  } finally {
    await srv.close();
  }
});

test("download forwards custom headers", async () => {
  const home = freshHome();
  let seen = "";
  const srv = await startServer((req, res) => {
    seen = String(req.headers["x-test"]);
    res.writeHead(200);
    res.end("ok");
  });
  try {
    await download(srv.url + "/h", join(home, "h.bin"), { headers: { "x-test": "hi" } });
    assert.equal(seen, "hi");
  } finally {
    await srv.close();
  }
});

test("extractTarGz unpacks a real archive and reports tar failures", async () => {
  const home = freshHome();
  const archive = join(home, "bundle.tgz");
  makeTarGz(archive, { "Runner.Client": "#!/bin/sh\n", "nested/x.txt": "hi" });
  const dest = join(home, "vendor");
  await extractTarGz(archive, dest);
  assert.equal(existsSync(join(dest, "Runner.Client")), true);
  assert.equal(readFileSync(join(dest, "nested/x.txt"), "utf8"), "hi");

  await assert.rejects(() => extractTarGz(join(home, "does-not-exist.tgz"), dest), /tar extraction failed/);
});

test("run returns the child's exit code and rejects on spawn error", async () => {
  fl.reset();
  assert.equal(await run(process.execPath, ["-e", "process.exit(0)"]), 0);
  assert.equal(await run(process.execPath, ["-e", "process.exit(7)"]), 7);
  await assert.rejects(() => run("this-binary-does-not-exist-xyz", []), /ENOENT|spawn/);
});

test("run tees child stdout to the active file log", async () => {
  const home = freshHome();
  const logPath = initFileLog(join(home, "logs"), "run");
  try {
    const code = await run(process.execPath, ["-e", "console.log('teed-line')"]);
    assert.equal(code, 0);
    // give the tee 'data' handler a tick to flush
    await new Promise((r) => setTimeout(r, 50));
    assert.match(readFileSync(logPath, "utf8"), /teed-line/);
  } finally {
    fl.reset();
  }
});

test("log writes to the active file log with a timestamp and no ANSI", async () => {
  const home = freshHome();
  const logPath = initFileLog(join(home, "logs"), "misc");
  try {
    log("hello world");
    await new Promise((r) => setTimeout(r, 60));
    const contents = readFileSync(logPath, "utf8");
    assert.match(contents, /\d{4}-\d\d-\d\dT.*\[ndh\] hello world/);
    assert.ok(!contents.includes("\x1b["), "ANSI must be stripped");
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
  } finally {
    fl.reset();
  }
});

test("randomToken is 48 lowercase hex chars", () => {
  const t = randomToken();
  assert.match(t, /^[0-9a-f]{48}$/);
  assert.notEqual(t, randomToken());
});

// ── hub reachability (#69) ────────────────────────────────────────────────────
test("connErrorCode digs a connection code out of a cause chain, ignores others", () => {
  // fetch() wraps the OS error as the `cause` of a "fetch failed" TypeError.
  const wrapped = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6099"), { code: "ECONNREFUSED" }) });
  assert.equal(connErrorCode(wrapped), "ECONNREFUSED");
  assert.equal(connErrorCode(Object.assign(new Error("dns"), { code: "ENOTFOUND" })), "ENOTFOUND");
  assert.equal(connErrorCode(Object.assign(new Error("aborted"), { name: "AbortError" })), "ETIMEDOUT");
  // A hub that answered with a bad status is NOT a connection error.
  assert.equal(connErrorCode(new Error("AgentPools: 503")), null);
  assert.equal(connErrorCode(Object.assign(new Error("weird"), { code: "EACCES" })), null);
});

test("rootErrorMessage returns the deepest cause message", () => {
  const wrapped = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:6099") });
  assert.equal(rootErrorMessage(wrapped), "connect ECONNREFUSED 127.0.0.1:6099");
  assert.equal(rootErrorMessage(new Error("plain")), "plain");
});

test("hubUnreachableMessage names the URL and the two likely causes", () => {
  const m = hubUnreachableMessage("http://hub:4949");
  assert.match(m, /http:\/\/hub:4949/);
  assert.match(m, /ndh hub up/);
  assert.match(m, /--server/);
});

test("probeServer: a listening host is reachable; a dead port is not (real sockets)", async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  // Reachable: any HTTP answer (even after we close, a live server) counts.
  assert.deepEqual(await probeServer(srv.url), { ok: true });
  await srv.close();
  // Now the port is closed → connection refused.
  const res = await probeServer(srv.url);
  assert.equal(res.ok, false);
  assert.equal(res.code, "ECONNREFUSED");
  assert.match(String(res.detail), /ECONNREFUSED/);
});

test("probeServer: a non-connection fetch failure is treated as reachable (let the real command speak)", async () => {
  // An unparseable URL rejects fetch without a connection code → probe stays optimistic.
  assert.deepEqual(await probeServer("http://[bad"), { ok: true });
});

test("humanSize renders bytes through terabytes and rejects nonsense", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize(158), "158 B");
  assert.equal(humanSize(1024), "1.0 KB");
  assert.equal(humanSize(1536), "1.5 KB");
  assert.equal(humanSize(20 * 1024), "20 KB");
  assert.equal(humanSize(3.4 * 1024 * 1024), "3.4 MB");
  assert.equal(humanSize(2 * 1024 ** 4), "2.0 TB");
  assert.equal(humanSize(-1), "");
  assert.equal(humanSize(Number.NaN), "");
});
