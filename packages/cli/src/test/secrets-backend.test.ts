import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSecret, getSecret, removeSecret, GLOBAL_SCOPE, __test } from "../secrets.js";

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ndh-backend-test-"));
  process.env.NDH_HOME = home;
  delete process.env.NDH_SECRETS_BACKEND;
  return home;
}

test("backend toggle: env override > persisted toggle > platform default", () => {
  const home = freshHome();

  process.env.NDH_SECRETS_BACKEND = "file";
  assert.equal(__test.backend(), "file", "env override wins");
  delete process.env.NDH_SECRETS_BACKEND;

  writeFileSync(join(home, "secrets-backend"), "file\n", { mode: 0o600 });
  assert.equal(__test.backend(), "file", "persisted 'file' toggle forces the file backend");

  writeFileSync(join(home, "secrets-backend"), "keyring\n", { mode: 0o600 });
  const b = __test.backend();
  if (process.platform === "darwin") {
    assert.equal(b, "keychain", "keyring preference resolves to Keychain on macOS");
  } else {
    assert.ok(b === "libsecret" || b === "file", "keyring preference resolves to libsecret or falls back");
  }

  writeFileSync(join(home, "secrets-backend"), "nonsense\n", { mode: 0o600 });
  const fallback = __test.backend();
  assert.ok(["keychain", "libsecret", "file"].includes(fallback), "invalid toggle is ignored, platform default applies");
});

test("libsecret backend: stdin-fed round-trip via fake secret-tool shim", async () => {
  const home = freshHome();
  process.env.NDH_SECRETS_BACKEND = "libsecret";

  // Fake secret-tool: stores secrets as files keyed by the attribute list; asserts stdin delivery.
  const shimDir = join(home, "shim");
  const stateDir = join(home, "shim-state");
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const shim = join(shimDir, "secret-tool");
  writeFileSync(
    shim,
    `#!/bin/bash
STATE="${stateDir}"
cmd="$1"; shift
if [ "$1" = "--label" ]; then shift 2; fi     # store passes --label first; key on attrs only
key=$(echo "$@" | tr ' /' '__')
case "$cmd" in
  store) cat > "$STATE/$key" ;;              # value must arrive on stdin
  lookup) [ -f "$STATE/$key" ] && cat "$STATE/$key" || exit 1 ;;
  clear) rm -f "$STATE/$key" ;;
  --help) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${oldPath}`;

  try {
    await setSecret(GLOBAL_SCOPE, "LSTEST", "libsecret-value\nline2");
    assert.equal(await getSecret(GLOBAL_SCOPE, "LSTEST"), "libsecret-value\nline2");

    // The value reached the shim via stdin (it is the file's content, written by `cat`).
    const files = readdirSync(stateDir);
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(stateDir, files[0]), "utf8"), "libsecret-value\nline2");

    // Byte-exact round-trip for a value ending in newline(s): `secret-tool lookup` prints the
    // stored bytes verbatim, so a trailing "\n" is part of the value and must survive — the same
    // exact-byte contract the keychain/file backends honor (#135). PEM keys / piped files end in one.
    const pem = "-----BEGIN KEY-----\nMIIB\n-----END KEY-----\n";
    await setSecret(GLOBAL_SCOPE, "LSPEM", pem);
    assert.equal(await getSecret(GLOBAL_SCOPE, "LSPEM"), pem, "trailing newline must not be stripped");
    await setSecret(GLOBAL_SCOPE, "LSNL", "x\n\n");
    assert.equal(await getSecret(GLOBAL_SCOPE, "LSNL"), "x\n\n", "all trailing newlines must survive");

    assert.equal(await removeSecret(GLOBAL_SCOPE, "LSTEST"), true);
    assert.equal(await getSecret(GLOBAL_SCOPE, "LSTEST"), null);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.NDH_SECRETS_BACKEND;
  }
});

test("libsecretAvailable: false without a session bus", () => {
  const oldDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
  const oldXdg = process.env.XDG_RUNTIME_DIR;
  delete process.env.DBUS_SESSION_BUS_ADDRESS;
  delete process.env.XDG_RUNTIME_DIR;
  try {
    assert.equal(__test.libsecretAvailable(), false);
  } finally {
    if (oldDbus !== undefined) process.env.DBUS_SESSION_BUS_ADDRESS = oldDbus;
    if (oldXdg !== undefined) process.env.XDG_RUNTIME_DIR = oldXdg;
  }
});
