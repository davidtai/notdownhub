import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, runCli, type Fixture } from "./helpers.js";
import { artifactsListCmd, artifactsDownloadCmd, __test } from "../artifacts-cmd.js";

const ZIP = Buffer.from("PKmy-artifact-zip-bytes");

/** Minimal fake hub: run 7 has artifact "my-artifact" (container 5, one file); run 9 has none. */
function fakeHub(): Promise<Fixture> {
  return startServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const j = (b: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (url.pathname === "/_apis/pipelines/workflows/7/artifacts")
      j({ value: [{ containerId: 5, size: 0, name: "my-artifact" }] });
    else if (url.pathname === "/_apis/pipelines/workflows/9/artifacts") j({ value: [] });
    else if (url.pathname === "/_apis/pipelines/workflows/container/5")
      j({ value: [{ path: "my-artifact.zip", itemType: "file", fileLength: ZIP.length }] });
    else if (url.pathname === "/_apis/pipelines/workflows/artifact/5") {
      res.writeHead(200);
      res.end(ZIP);
    } else {
      res.writeHead(404);
      res.end("no");
    }
  });
}

/** Capture console.log while running `fn`. */
async function captureLog(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const orig = console.log;
  let out = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  try {
    const code = await fn();
    return { code, out };
  } finally {
    console.log = orig;
  }
}

test("normalizeServer trims trailing slashes", () => {
  assert.equal(__test.normalizeServer("http://h:4949/"), "http://h:4949");
  assert.equal(__test.normalizeServer("http://h:4949///"), "http://h:4949");
  assert.equal(__test.normalizeServer("http://h:4949"), "http://h:4949");
});

test("artifactsListCmd prints a name/size/id table", async () => {
  const hub = await fakeHub();
  try {
    const { code, out } = await captureLog(() => artifactsListCmd("7", { server: hub.url }));
    assert.equal(code, 0);
    assert.match(out, /NAME/);
    assert.match(out, /my-artifact/);
    assert.match(out, new RegExp(`${ZIP.length} B`)); // archive size
    assert.match(out, /\b5\b/); // id
  } finally {
    await hub.close();
  }
});

test("artifactsListCmd reports a run with no artifacts (exit 0, no table)", async () => {
  const hub = await fakeHub();
  try {
    const { code, out } = await captureLog(() => artifactsListCmd("9", { server: hub.url }));
    assert.equal(code, 0);
    assert.doesNotMatch(out, /NAME/);
  } finally {
    await hub.close();
  }
});

test("artifactsDownloadCmd writes the artifact to --out", async () => {
  const hub = await fakeHub();
  const out = mkdtempSync(join(tmpdir(), "ndh-artcmd-"));
  try {
    const code = await artifactsDownloadCmd("7", "my-artifact", { server: hub.url, out });
    assert.equal(code, 0);
    assert.deepEqual(readFileSync(join(out, "my-artifact.zip")), ZIP);
  } finally {
    await hub.close();
  }
});

// ── CLI wiring (subprocess: fail() calls process.exit, which must not kill the test runner) ──

test("ndh artifacts <run-id> lists via the registered command", async () => {
  const hub = await fakeHub();
  try {
    const r = await runCli(["artifacts", "7", "--server", hub.url]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /my-artifact/);
  } finally {
    await hub.close();
  }
});

test("ndh artifacts download <run-id> <name> fetches via the registered subcommand", async () => {
  const hub = await fakeHub();
  const out = mkdtempSync(join(tmpdir(), "ndh-artcli-"));
  try {
    const r = await runCli(["artifacts", "download", "7", "my-artifact", "--out", out, "--server", hub.url]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /downloaded/);
    assert.deepEqual(readFileSync(join(out, "my-artifact.zip")), ZIP);
  } finally {
    await hub.close();
  }
});

test("ndh artifacts rejects a non-numeric run id", async () => {
  const r = await runCli(["artifacts", "abc", "--server", "http://127.0.0.1:1"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid run id/);
});

test("ndh artifacts download fails clearly for an unknown artifact", async () => {
  const hub = await fakeHub();
  try {
    const r = await runCli(["artifacts", "download", "7", "ghost", "--server", hub.url]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no artifact 'ghost'/);
  } finally {
    await hub.close();
  }
});

test("ndh artifacts with no run id and no subcommand prints usage", async () => {
  const r = await runCli(["artifacts"]);
  assert.match(r.stdout + r.stderr, /download/);
});
