import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { cleanupHomes } from "./helpers.js";

/**
 * Global test isolation. Imported before any test (via the `test` script's --import), this
 * forces NDH_HOME onto a throwaway temp directory so NO test can ever read or write the real
 * ~/.notdownhub — its hub DB, job logs, runner tokens, or secrets. Individual tests may still
 * set their own NDH_HOME; this only guarantees a safe default when they do not.
 */
let setupRoot: string | undefined;
if (!process.env.NDH_HOME || process.env.NDH_HOME === join(process.env.HOME ?? "", ".notdownhub")) {
  setupRoot = mkdtempSync(join(tmpdir(), "ndh-test-root-"));
  process.env.NDH_HOME = setupRoot;
}
// Never touch the real login Keychain from tests, even if a case forgets to override it.
process.env.NDH_KEYCHAIN_SERVICE ??= `notdownhub-test-${process.pid}`;

/**
 * Suite-end teardown: delete every temp home (and its databases) this process created — the ones
 * handed out by freshHome() plus this file's own root — so test DBs never linger under the OS temp
 * dir. Registered here so it runs regardless of which test files the process loaded.
 */
after(() => {
  cleanupHomes();
  if (setupRoot) rmSync(setupRoot, { recursive: true, force: true });
});
