import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { download, exists, extractTarGz, fail, log, ndhHome, vendorDir, vendorExe, vendorRid, VENDOR_TAG, VENDOR_VERSION } from "./lib.js";

const RELEASE_BASE = "https://github.com/ChristopherHX/runner.server/releases/download";

/** Download + extract the pinned Runner.Server bundle (server, client, and runner in one). */
export async function ensureVendor(force = false): Promise<string> {
  const dir = vendorDir();
  const marker = join(dir, ".ndh-complete");
  if (!force && (await exists(marker))) return dir;

  const rid = vendorRid();
  const cache = join(ndhHome(), "cache", `runner.server-${rid}-${VENDOR_VERSION}.tar.gz`);
  if (force || !(await exists(cache))) {
    const url = process.env.NDH_VENDOR_URL ?? `${RELEASE_BASE}/${VENDOR_TAG}/runner.server-${rid}.tar.gz`;
    log(`downloading runner.server ${VENDOR_VERSION} (${rid}) ...`);
    await mkdir(join(ndhHome(), "cache"), { recursive: true });
    await download(url, cache);
  }
  await rm(dir, { recursive: true, force: true });
  log(`extracting to ${dir} ...`);
  await extractTarGz(cache, dir);
  if (!(await exists(vendorExe("Runner.Client")))) {
    fail("vendor bundle missing Runner.Client after extraction");
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(marker, `${VENDOR_VERSION}\n`);
  log("vendor stack ready");
  return dir;
}
