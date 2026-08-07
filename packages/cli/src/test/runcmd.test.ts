import { test } from "node:test";
import assert from "node:assert/strict";
import { __test } from "../runcmd.js";

const { defaultPlatformArgs } = __test;

test("defaultPlatformArgs: user-supplied -P / --platform suppresses the defaults", () => {
  assert.deepEqual(defaultPlatformArgs(["-P", "x=y"]), []);
  assert.deepEqual(defaultPlatformArgs(["--platform", "x=y"]), []);
});

test("defaultPlatformArgs: linux images map to docker when available", () => {
  const args = defaultPlatformArgs(["--event", "push"], () => true);
  assert.ok(args.includes("ubuntu-latest=catthehacker/ubuntu:act-latest"));
  assert.ok(args.includes("ubuntu-24.04=catthehacker/ubuntu:act-latest"));
  assert.ok(args.includes("self-hosted=-self-hosted"));
});

test("defaultPlatformArgs: linux images fall back to the host without docker", () => {
  const args = defaultPlatformArgs(["--event", "push"], () => false);
  assert.ok(args.includes("ubuntu-latest=-self-hosted"));
  assert.ok(args.includes("macos-latest=-self-hosted"));
  assert.ok(args.includes("windows-latest=-self-hosted"));
});
