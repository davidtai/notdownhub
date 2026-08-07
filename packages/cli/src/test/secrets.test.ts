import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  GLOBAL_SCOPE,
  setSecret,
  getSecret,
  listSecrets,
  removeSecret,
  formatSecretFile,
  writeSecretFile,
  resolveSecretsForRun,
} from "../secrets.js";
import { runCmd, dispatchCmd } from "../runcmd.js";

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ndh-test-"));
  process.env.NDH_HOME = home;
  process.env.NDH_SECRETS_BACKEND = "file"; // deterministic across platforms
  return home;
}

const noEnsure = async () => 0;

test("file backend: set / get / list / rm round-trip", async () => {
  freshHome();
  await setSecret(GLOBAL_SCOPE, "A", "value-a");
  await setSecret(GLOBAL_SCOPE, "B", "value-b");
  await setSecret("owner/repo", "A", "repo-value-a");

  assert.equal(await getSecret(GLOBAL_SCOPE, "A"), "value-a");
  assert.equal(await getSecret(GLOBAL_SCOPE, "B"), "value-b");
  assert.equal(await getSecret("owner/repo", "A"), "repo-value-a");
  assert.equal(await getSecret(GLOBAL_SCOPE, "MISSING"), null);

  // list is names + scopes only, never values
  const all = await listSecrets();
  assert.equal(all.length, 3);
  assert.ok(all.every((e) => !("value" in e)));
  assert.deepEqual(
    (await listSecrets(GLOBAL_SCOPE)).map((e) => e.name).sort(),
    ["A", "B"],
  );
  assert.deepEqual((await listSecrets("owner/repo")).map((e) => e.name), ["A"]);

  // the persisted file must not contain plaintext, and must be 0600
  const storeRaw = readFileSync(join(process.env.NDH_HOME!, "secrets.json"), "utf8");
  assert.ok(!storeRaw.includes("value-a"), "values must be encrypted at rest");
  assert.equal(statSync(join(process.env.NDH_HOME!, "secrets.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(process.env.NDH_HOME!, "secrets.key")).mode & 0o777, 0o600);

  // rm
  assert.equal(await removeSecret(GLOBAL_SCOPE, "A"), true);
  assert.equal(await removeSecret(GLOBAL_SCOPE, "A"), false); // already gone
  assert.equal(await getSecret(GLOBAL_SCOPE, "A"), null);
  assert.deepEqual((await listSecrets(GLOBAL_SCOPE)).map((e) => e.name), ["B"]);
  assert.equal(await getSecret("owner/repo", "A"), "repo-value-a"); // repo scope untouched
});

test("resolveSecretsForRun: repo scope overrides global", async () => {
  freshHome();
  await setSecret(GLOBAL_SCOPE, "SHARED", "global");
  await setSecret(GLOBAL_SCOPE, "ONLY_GLOBAL", "g");
  await setSecret("o/r", "SHARED", "repo");
  await setSecret("o/r", "ONLY_REPO", "r");

  const globalOnly = await resolveSecretsForRun(null);
  assert.equal(globalOnly.get("SHARED"), "global");
  assert.equal(globalOnly.has("ONLY_REPO"), false);

  const withRepo = await resolveSecretsForRun("o/r");
  assert.equal(withRepo.get("SHARED"), "repo"); // repo overrides global
  assert.equal(withRepo.get("ONLY_GLOBAL"), "g");
  assert.equal(withRepo.get("ONLY_REPO"), "r");
});

test("secret-file syntax: single-line and multiline heredoc", async () => {
  const entries = new Map<string, string>([
    ["SINGLE", "hello world"],
    ["MULTI", "line1\nline2\nline3"],
  ]);
  const text = formatSecretFile(entries);

  assert.match(text, /^SINGLE=hello world$/m);

  // heredoc block with a randomized delimiter that is not present in the value
  const m = text.match(/^MULTI<<(\S+)\n([\s\S]*?)\n\1$/m);
  assert.ok(m, "MULTI should be a heredoc block");
  assert.equal(m![2], "line1\nline2\nline3");
  assert.ok(!"line1\nline2\nline3".includes(m![1]), "delimiter must not collide with value");

  // empty map → empty file
  assert.equal(formatSecretFile(new Map()), "");
});

test("writeSecretFile: 0600 ephemeral file with correct contents", async () => {
  freshHome();
  const path = await writeSecretFile(new Map([["K", "v"]]));
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8"), "K=v\n");
  } finally {
    if (existsSync(path)) rmSync(path);
  }
});

test("argv-leak guard: run injects --secret-file, never the value; file shredded after", async () => {
  freshHome();
  const SECRET = "topsecretvalue-do-not-leak";
  await setSecret(GLOBAL_SCOPE, "LEAKME", SECRET);

  let captured: string[] = [];
  let secretFilePath = "";
  let fileContents = "";
  const runner = async (_cmd: string, args: string[]): Promise<number> => {
    captured = args;
    const i = args.indexOf("--secret-file");
    secretFilePath = args[i + 1];
    fileContents = readFileSync(secretFilePath, "utf8");
    return 0;
  };

  const code = await runCmd(["-W", ".github/workflows/ci.yml", "--event", "push"], {
    runner,
    ensure: noEnsure,
    repoSlug: () => null,
  });
  assert.equal(code, 0);

  // the value must never appear in argv
  assert.ok(!JSON.stringify(captured).includes(SECRET), "secret value must not be in argv");
  // but the secret must have been delivered via the file
  assert.ok(captured.includes("--secret-file"));
  assert.ok(fileContents.includes(SECRET), "secret file should carry the value");
  assert.match(fileContents, /^LEAKME=topsecretvalue-do-not-leak$/m);
  // file is shredded + removed in the finally block
  assert.equal(existsSync(secretFilePath), false, "secret file must be deleted after the run");
});

test("run: verbatim passthrough including default platform args and a leading `--`", async () => {
  freshHome(); // no secrets stored → no --secret-file appended
  let captured: string[] = [];
  const runner = async (_cmd: string, args: string[]): Promise<number> => {
    captured = args;
    return 0;
  };

  await runCmd(["--", "-W", "x.yml"], { runner, ensure: noEnsure, repoSlug: () => null });
  assert.ok(!captured.includes("--secret-file"), "no secrets → no secret-file");
  // default platform args are prepended, user args pass through verbatim at the tail incl. `--`
  assert.ok(captured.includes("-P"));
  assert.deepEqual(captured.slice(-3), ["--", "-W", "x.yml"]);

  // when the user supplies -P, default platform mappings are suppressed (original behavior)
  await runCmd(["-P", "ubuntu-latest=node:20", "--event", "push"], {
    runner,
    ensure: noEnsure,
    repoSlug: () => null,
  });
  // --repository is injected ahead of the user args (origin-less → local/ fallback);
  // the user's -P still suppresses the default platform mappings.
  assert.equal(captured[0], "--repository");
  assert.match(captured[1], /^local\//);
  assert.deepEqual(captured.slice(2), ["-P", "ubuntu-latest=node:20", "--event", "push"]);
});

test("dispatch: requires --server; passes args verbatim without leaking secrets", async () => {
  freshHome();
  await setSecret(GLOBAL_SCOPE, "TOK", "sekret");
  let captured: string[] = [];
  const runner = async (_cmd: string, args: string[]): Promise<number> => {
    captured = args;
    return 0;
  };

  // missing --server → usage error exit 2, runner never called
  let called = false;
  const code = await dispatchCmd(["--event", "push"], {
    runner: async () => {
      called = true;
      return 0;
    },
    ensure: noEnsure,
    repoSlug: () => null,
  });
  assert.equal(code, 2);
  assert.equal(called, false);

  // with --server → args verbatim + secret-file, no value in argv
  await dispatchCmd(["--server", "http://hub:4949", "--event", "push"], {
    runner,
    ensure: noEnsure,
    repoSlug: () => null,
    probe: async () => ({ ok: true }), // hub reachable — exercise the argv/secret-file assembly
  });
  assert.ok(captured.includes("--server"));
  assert.ok(captured.includes("--secret-file"));
  assert.ok(!JSON.stringify(captured).includes("sekret"));
  // user args are present verbatim
  assert.ok(captured.join(" ").includes("--server http://hub:4949 --event push"));
});

test("status against an unreachable hub prints the error and exits 1 (no silent failure)", () => {
  // Regression guard: with commander.exitOverride(), errors thrown inside an action are NOT
  // printed by commander. main() must surface them like the old fail() handler did.
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
  // port 1 → connection refused, fast and deterministic
  const r = spawnSync(process.execPath, [cli, "status", "--server", "http://127.0.0.1:1"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1, "should exit 1 on a runtime failure");
  assert.match(r.stderr, /\[ndh\]/, "should print the [ndh] error prefix to stderr");
  assert.ok(r.stderr.trim().length > "[ndh]".length, "should include an error message");
});

// macOS-only smoke test of the real Keychain backend with a throwaway service name.
test(
  "keychain backend smoke (macOS)",
  { skip: process.platform !== "darwin" ? "not macOS" : false },
  async () => {
    const home = freshHome();
    process.env.NDH_SECRETS_BACKEND = "keychain";
    process.env.NDH_KEYCHAIN_SERVICE = `notdownhub-test-${process.pid}-${Date.now()}`;
    const svc = process.env.NDH_KEYCHAIN_SERVICE;
    try {
      await setSecret(GLOBAL_SCOPE, "KCTEST", "kc-value");
      assert.equal(await getSecret(GLOBAL_SCOPE, "KCTEST"), "kc-value");
      assert.deepEqual((await listSecrets(GLOBAL_SCOPE)).map((e) => e.name), ["KCTEST"]);
      assert.equal(await removeSecret(GLOBAL_SCOPE, "KCTEST"), true);
      assert.equal(await getSecret(GLOBAL_SCOPE, "KCTEST"), null);
    } finally {
      // best-effort cleanup in case an assertion failed mid-way
      spawnSync("security", ["delete-generic-password", "-s", `${svc}:${GLOBAL_SCOPE}`, "-a", "KCTEST"], {
        stdio: "ignore",
      });
      delete process.env.NDH_KEYCHAIN_SERVICE;
      void home;
    }
  },
);
