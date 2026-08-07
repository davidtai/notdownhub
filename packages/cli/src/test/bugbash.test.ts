import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download, run } from "../lib.js";
import { initFileLog, __test as fileLogTest } from "../filelog.js";
import { setSecret, getSecret, validEnvName, GLOBAL_SCOPE } from "../secrets.js";
import { dispatchCmd } from "../runcmd.js";

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ndh-bugbash-"));
  process.env.NDH_HOME = home;
  process.env.NDH_SECRETS_BACKEND = "file";
  return home;
}

// #1 — interrupted download rejects cleanly (does NOT crash the process with an unhandled error).
test("download: interrupted transfer rejects instead of throwing an unhandled error", async () => {
  const home = freshHome();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-length": "1000000" });
    res.write(Buffer.alloc(100));
    setImmediate(() => res.socket?.destroy()); // truncate mid-body
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  await assert.rejects(
    () => download(`http://127.0.0.1:${port}/x`, join(home, "out.bin")),
    /download failed/,
  );
  server.close();
});

// #2 — teed child output is fully captured (resolve on 'close', not 'exit').
test("run: teed output is not truncated on a fast-exiting child", async () => {
  const home = freshHome();
  initFileLog(join(home, "logs"), "t");
  const code = await run(process.execPath, ["-e", "for(let i=0;i<5000;i++)console.log('L'+i);"]);
  assert.equal(code, 0);
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = join(home, "logs");
  const logFile = join(dir, readdirSync(dir)[0]);
  const body = readFileSync(logFile, "utf8");
  assert.ok(body.includes("L0") && body.includes("L4999"), "first and last teed lines must both be present");
  fileLogTest.reset();
});

// #3 — repeated run() calls do not leak signal listeners.
test("run: does not accumulate SIGINT/SIGTERM listeners", async () => {
  freshHome();
  const before = process.listenerCount("SIGINT");
  for (let i = 0; i < 6; i++) await run(process.execPath, ["-e", "0"]);
  assert.ok(process.listenerCount("SIGINT") <= before, "SIGINT listeners must not grow across run() calls");
});

// #4 — dispatch accepts the --server=<url> form.
test("dispatch: accepts --server=<url> (not only --server <url>)", async () => {
  freshHome();
  let called = false;
  const code = await dispatchCmd(["--server=http://hub:4949", "--event", "push"], {
    runner: async () => {
      called = true;
      return 0;
    },
    ensure: async () => 0,
    repoSlug: () => null,
  });
  assert.equal(code, 0);
  assert.ok(called, "runner must be invoked for the --server=<url> form");
});

// name validation (LOW) — secret/var names must be valid env identifiers.
// setSecret with a bad name calls fail()→process.exit, so the guard is tested via validEnvName.
test("validEnvName rejects names that would corrupt the env/secret file", () => {
  assert.ok(validEnvName("MY_TOKEN"));
  assert.ok(validEnvName("_x1"));
  assert.ok(!validEnvName("A=B"));
  assert.ok(!validEnvName("A B"));
  assert.ok(!validEnvName("2FA"));
  assert.ok(!validEnvName(""));
  assert.ok(!validEnvName("A\nB"), "a newline in a name would poison the whole secret file");
});

// keychain base64 round-trip (HIGH) — only meaningful on macOS with the real backend.
test(
  "keychain: multiline + unicode secret round-trips (base64)",
  { skip: process.platform !== "darwin" ? "not macOS" : false },
  async () => {
    freshHome();
    process.env.NDH_SECRETS_BACKEND = "keychain";
    process.env.NDH_KEYCHAIN_SERVICE = `notdownhub-bugbash-${process.pid}-${Date.now()}`;
    const svc = process.env.NDH_KEYCHAIN_SERVICE;
    const value = "-----BEGIN KEY-----\nline2\ncafé 🔑\n-----END KEY-----";
    try {
      await setSecret(GLOBAL_SCOPE, "PEM", value);
      assert.equal(await getSecret(GLOBAL_SCOPE, "PEM"), value, "multiline/unicode must survive the Keychain round-trip");
    } finally {
      const { spawnSync } = await import("node:child_process");
      spawnSync("security", ["delete-generic-password", "-s", `${svc}:${GLOBAL_SCOPE}`, "-a", "PEM"], { stdio: "ignore" });
      delete process.env.NDH_KEYCHAIN_SERVICE;
    }
  },
);
