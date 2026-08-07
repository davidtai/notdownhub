import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import {
  GLOBAL_SCOPE,
  setSecret,
  getSecret,
  listSecrets,
  removeSecret,
  backendName,
  currentRepoSlug,
  readSecretValue,
  __test as secretsInternal,
} from "../secrets.js";
import { freshHome, fakeSecurityDir } from "./helpers.js";

test("keychain backend: set/get/list/rm via the `security` CLI (fake shim on PATH)", async () => {
  freshHome();
  const savedPath = process.env.PATH;
  const savedBackend = process.env.NDH_SECRETS_BACKEND;
  process.env.PATH = fakeSecurityDir() + delimiter + savedPath;
  process.env.NDH_SECRETS_BACKEND = "keychain";
  process.env.NDH_KEYCHAIN_SERVICE = `ndh-test-${process.pid}`;
  try {
    assert.equal(backendName(), "macOS Keychain");
    await setSecret(GLOBAL_SCOPE, "KC", "kc-value");
    assert.equal(await getSecret(GLOBAL_SCOPE, "KC"), "kc-value");
    assert.deepEqual((await listSecrets(GLOBAL_SCOPE)).map((e) => e.name), ["KC"]);
    // missing key -> null (find-generic-password exits non-zero)
    assert.equal(await getSecret(GLOBAL_SCOPE, "ABSENT"), null);
    // remove
    assert.equal(await removeSecret(GLOBAL_SCOPE, "KC"), true);
    assert.equal(await removeSecret(GLOBAL_SCOPE, "KC"), false);
    assert.equal(await getSecret(GLOBAL_SCOPE, "KC"), null);
    // a keychain write failure is surfaced as an error whose extra line names the headless/SSH
    // fix (`ndh secrets backend file`) so an SSH-only user is not dead in the water (#42).
    await assert.rejects(
      () => setSecret(GLOBAL_SCOPE, "BAD", "FAILWRITE"),
      (err: Error) => {
        assert.match(err.message, /^keychain write failed:/, "keeps the original failure prefix");
        assert.match(err.message, /headless\/SSH sessions often cannot unlock the login Keychain/);
        assert.match(err.message, /ndh secrets backend file/, "names the file-backend fix");
        assert.match(err.message, /encrypted-file backend/);
        return true;
      },
    );
  } finally {
    process.env.PATH = savedPath;
    if (savedBackend === undefined) delete process.env.NDH_SECRETS_BACKEND;
    else process.env.NDH_SECRETS_BACKEND = savedBackend;
    delete process.env.NDH_KEYCHAIN_SERVICE;
  }
});

test("backendName reflects the file backend", () => {
  const saved = process.env.NDH_SECRETS_BACKEND;
  process.env.NDH_SECRETS_BACKEND = "file";
  assert.match(backendName(), /encrypted file/);
  process.env.NDH_SECRETS_BACKEND = saved!;
});

function gitRepo(remote?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ndh-git-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  if (remote) spawnSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

test("currentRepoSlug parses ssh + https remotes, and returns null without one", () => {
  assert.equal(currentRepoSlug(gitRepo("git@github.com:owner/name.git")), "owner/name");
  assert.equal(currentRepoSlug(gitRepo("https://github.com/acme/proj")), "acme/proj");
  assert.equal(currentRepoSlug(gitRepo()), null, "git repo without an origin remote");
  assert.equal(currentRepoSlug(mkdtempSync(join(tmpdir(), "ndh-nogit-"))), null, "not a git repo");
});

test("readSecretValue returns the inline --value verbatim", async () => {
  assert.equal(await readSecretValue("inline-secret"), "inline-secret");
});

/**
 * Drive the hidden prompt with a stubbed process.stdin (an EventEmitter with the
 * stream methods promptHidden touches). setRawMode is absent on purpose — the
 * code optional-chains it, exactly as on a non-raw stdin.
 */
function withFakeStdin<T>(fn: (emit: (chunk: string) => void) => Promise<T>): Promise<T> {
  const fake = new EventEmitter() as EventEmitter & {
    resume: () => void;
    pause: () => void;
    setEncoding: (e: string) => void;
    removeListener: (ev: string, l: (...a: unknown[]) => void) => EventEmitter;
  };
  fake.resume = () => {};
  fake.pause = () => {};
  fake.setEncoding = () => {};
  const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  return fn((chunk) => fake.emit("data", chunk)).finally(() => {
    Object.defineProperty(process, "stdin", original);
  });
}

test("hidden prompt: Enter terminates input and is NOT part of the secret (#135)", async () => {
  for (const terminator of ["\n", "\r", "\u0004" /* Ctrl-D */]) {
    const value = await withFakeStdin((emit) => {
      const p = secretsInternal.promptHidden("value: ");
      emit("typed-");
      emit(`secret${terminator}`);
      return p;
    });
    assert.equal(value, "typed-secret", `terminator ${JSON.stringify(terminator)} is stripped`);
  }
});

test("hidden prompt: backspace edits, Ctrl-C aborts", async () => {
  const edited = await withFakeStdin((emit) => {
    const p = secretsInternal.promptHidden("value: ");
    emit("abX\u007f");
    emit("c\r");
    return p;
  });
  assert.equal(edited, "abc", "DEL removes the last typed character");

  await assert.rejects(
    withFakeStdin((emit) => {
      const p = secretsInternal.promptHidden("value: ");
      emit("oops\u0003");
      return p;
    }),
    /aborted/,
  );
});

test("shred: overwrites+removes a real file, no-ops an empty one, and ignores a missing path", async () => {
  const home = freshHome();
  const file = join(home, "s.env");
  writeFileSync(file, "SECRET=abc\n");
  await secretsInternal.shred(file);
  assert.equal(existsSync(file), false, "non-empty file shredded + removed");

  const empty = join(home, "empty.env");
  writeFileSync(empty, "");
  await secretsInternal.shred(empty); // size 0 -> skip the overwrite branch
  assert.equal(existsSync(empty), false);

  // missing path: readFile throws -> caught and ignored, rm best-effort
  await assert.doesNotReject(() => secretsInternal.shred(join(home, "does-not-exist.env")));
});
