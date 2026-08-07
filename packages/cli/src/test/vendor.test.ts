import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVendor } from "../vendor.js";
import { vendorDir, vendorExe, vendorRid, VENDOR_VERSION } from "../lib.js";
import { freshHome, startServer, makeTarGz } from "./helpers.js";

/** A tarball whose root contains a fake Runner.Client (what ensureVendor verifies post-extract). */
function bundleBytes(): Buffer {
  const p = join(mkdtempSync(join(tmpdir(), "ndh-bundle-")), "bundle.tgz");
  makeTarGz(p, { "Runner.Client": "#!/bin/sh\necho client\n", "Runner.Server": "#!/bin/sh\n" });
  return readFileSync(p);
}

test("ensureVendor: downloads, extracts, verifies Runner.Client, and marks complete (then no-ops)", async () => {
  freshHome();
  const bytes = bundleBytes();
  let hits = 0;
  const srv = await startServer((_req, res) => {
    hits++;
    res.writeHead(200);
    res.end(bytes);
  });
  process.env.NDH_VENDOR_URL = srv.url + "/bundle.tgz";
  try {
    const dir = await ensureVendor();
    assert.equal(dir, vendorDir());
    assert.equal(existsSync(vendorExe("Runner.Client")), true);
    assert.equal(existsSync(join(vendorDir(), ".ndh-complete")), true);
    assert.equal(hits, 1);

    // second call: marker present -> returns immediately, no fetch
    await srv.close();
    assert.equal(await ensureVendor(), vendorDir());
  } finally {
    delete process.env.NDH_VENDOR_URL;
  }
});

test("ensureVendor: force re-downloads even when already complete", async () => {
  freshHome();
  const bytes = bundleBytes();
  let hits = 0;
  const srv = await startServer((_req, res) => {
    hits++;
    res.writeHead(200);
    res.end(bytes);
  });
  process.env.NDH_VENDOR_URL = srv.url + "/bundle.tgz";
  try {
    await ensureVendor();
    assert.equal(hits, 1);
    await ensureVendor(true); // force
    assert.equal(hits, 2);
  } finally {
    delete process.env.NDH_VENDOR_URL;
    await srv.close();
  }
});

test("ensureVendor: uses an existing cache archive without downloading", async () => {
  const home = freshHome();
  const cache = join(home, "cache", `runner.server-${vendorRid()}-${VENDOR_VERSION}.tar.gz`);
  makeTarGz(cache, { "Runner.Client": "#!/bin/sh\n" });
  // Point the URL at a server that would 500 — it must never be consulted.
  const srv = await startServer((_req, res) => {
    res.writeHead(500);
    res.end("should not be called");
  });
  process.env.NDH_VENDOR_URL = srv.url + "/bundle.tgz";
  try {
    const dir = await ensureVendor();
    assert.equal(existsSync(join(dir, "Runner.Client")), true);
  } finally {
    delete process.env.NDH_VENDOR_URL;
    await srv.close();
  }
});
