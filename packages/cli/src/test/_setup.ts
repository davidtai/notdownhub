import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Global test isolation. Imported before any test (via the `test` script's --import), this
 * forces NDH_HOME onto a throwaway temp directory so NO test can ever read or write the real
 * ~/.notdownhub — its hub DB, job logs, runner tokens, or secrets. Individual tests may still
 * set their own NDH_HOME; this only guarantees a safe default when they do not.
 */
if (!process.env.NDH_HOME || process.env.NDH_HOME === join(process.env.HOME ?? "", ".notdownhub")) {
  process.env.NDH_HOME = mkdtempSync(join(tmpdir(), "ndh-test-root-"));
}
// Never touch the real login Keychain from tests, even if a case forgets to override it.
process.env.NDH_KEYCHAIN_SERVICE ??= `notdownhub-test-${process.pid}`;
