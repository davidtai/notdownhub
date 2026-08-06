import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// dist/test/smoke.test.js -> dist/index.js
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

function ndh(args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("--version prints the package version", () => {
  assert.match(ndh(["--version"]).trim(), /^\d+\.\d+\.\d+$/);
});

test("help lists the core commands", () => {
  const out = ndh(["--help"]);
  for (const cmd of ["install", "run", "hub up", "runner join", "dispatch", "status"]) {
    assert.ok(out.includes(cmd), `help should mention '${cmd}'`);
  }
});
