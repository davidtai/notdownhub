import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type Fixture } from "./helpers.js";
import {
  listArtifacts,
  fetchContainerFiles,
  resolveArtifact,
  serveArtifactDownload,
  downloadArtifact,
  parseArtifactPrettyUrl,
  parseArtifactApiPath,
} from "../artifacts.js";

const ZIP = Buffer.from("PKmy-artifact-zip-bytes");

/**
 * A fake hub speaking the engine's v3 pipelines artifact API:
 *   run 7  → one artifact "my-artifact" (container 5), one file my-artifact.zip
 *   run 9  → no artifacts (empty)
 *   run 40 → artifact whose FILE read 500s (upstream blob failure)
 *   run 50 → the artifacts LIST itself 500s
 */
function fakeHub(): Promise<Fixture> {
  return startServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const j = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/_apis/pipelines/workflows/7/artifacts") {
      j({ count: 1, value: [{ containerId: 5, size: 0, name: "my-artifact", type: "actions_storage" }] });
    } else if (url.pathname === "/_apis/pipelines/workflows/9/artifacts") {
      j({ count: 0, value: [] });
    } else if (url.pathname === "/_apis/pipelines/workflows/40/artifacts") {
      j({ count: 1, value: [{ containerId: 6, size: 0, name: "bad", type: "actions_storage" }] });
    } else if (url.pathname === "/_apis/pipelines/workflows/50/artifacts") {
      res.writeHead(500);
      res.end("boom");
    } else if (url.pathname === "/_apis/pipelines/workflows/container/5") {
      j({
        value: [
          { path: "my-artifact.zip", itemType: "file", fileLength: ZIP.length },
          { path: "adir", itemType: "folder" },
        ],
      });
    } else if (url.pathname === "/_apis/pipelines/workflows/container/6") {
      j({ value: [{ path: "bad.zip", itemType: "file", fileLength: 3 }] });
    } else if (url.pathname === "/_apis/pipelines/workflows/artifact/5") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(ZIP);
    } else if (url.pathname === "/_apis/pipelines/workflows/artifact/6") {
      res.writeHead(500);
      res.end("blob gone");
    } else if (url.pathname === "/_apis/pipelines/workflows/60/artifacts") {
      // run 60 → a MALICIOUS artifact whose file path escapes the output dir (zip-slip)
      j({ count: 1, value: [{ containerId: 8, size: 0, name: "evil", type: "actions_storage" }] });
    } else if (url.pathname === "/_apis/pipelines/workflows/container/8") {
      j({ value: [{ path: "../escape.txt", itemType: "file", fileLength: 4 }] });
    } else if (url.pathname === "/_apis/pipelines/workflows/artifact/8") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("pwnd");
    } else {
      res.writeHead(404);
      res.end("no");
    }
  });
}

/** Wrap a handler in a real server + fetch it, so streaming download branches are exercised end to end. */
async function fetchThrough(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
  path: string,
): Promise<{ status: number; headers: Headers; buf: Buffer }> {
  const srv = await startServer((req, res) => void handler(req, res));
  try {
    const r = await fetch(`${srv.url}${path}`);
    return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  } finally {
    await srv.close();
  }
}

test("downloadArtifact rejects a zip-slip path and writes nothing outside outDir (#157)", async () => {
  const hub = await fakeHub();
  const base = mkdtempSync(join(tmpdir(), "ndh-artdl-"));
  const out = join(base, "dl");
  try {
    // An attacker-controlled artifact file path of "../escape.txt" must be refused, not written.
    await assert.rejects(() => downloadArtifact(hub.url, 60, "evil", out), /unsafe artifact path/);
    // The traversal target (base/escape.txt — one level ABOVE out) must not have been created.
    assert.equal(existsSync(join(base, "escape.txt")), false);
  } finally {
    await hub.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("parseArtifactPrettyUrl matches the printed URL only", () => {
  assert.deepEqual(parseArtifactPrettyUrl("/local/repro/actions/runs/4/artifacts/5"), { runId: 4, artifactId: "5" });
  assert.deepEqual(parseArtifactPrettyUrl("/o/r/actions/runs/12/artifacts/3/"), { runId: 12, artifactId: "3" });
  assert.equal(parseArtifactPrettyUrl("/_apis/pipelines/workflows/4/artifacts"), null);
  assert.equal(parseArtifactPrettyUrl("/o/r/actions/runs/4/artifacts"), null);
  assert.equal(parseArtifactPrettyUrl("/dashboard"), null);
});

test("parseArtifactApiPath splits list vs download and ignores foreign paths", () => {
  assert.deepEqual(parseArtifactApiPath("/api/local/artifacts/7"), { runId: 7, selector: null });
  assert.deepEqual(parseArtifactApiPath("/api/local/artifacts/7/my-artifact"), { runId: 7, selector: "my-artifact" });
  assert.deepEqual(parseArtifactApiPath("/api/local/artifacts/7/name%20with%20space"), {
    runId: 7,
    selector: "name with space",
  });
  assert.equal(parseArtifactApiPath("/_apis/pipelines/workflows/7/artifacts"), null);
  assert.equal(parseArtifactApiPath("/api/local/agents"), null);
});

test("listArtifacts computes real size from the container files", async () => {
  const hub = await fakeHub();
  try {
    assert.deepEqual(await listArtifacts(hub.url, 7), [{ id: 5, name: "my-artifact", size: ZIP.length }]);
  } finally {
    await hub.close();
  }
});

test("listArtifacts returns [] for a run with no artifacts and for an errored list", async () => {
  const hub = await fakeHub();
  try {
    assert.deepEqual(await listArtifacts(hub.url, 9), []);
    assert.deepEqual(await listArtifacts(hub.url, 50), []);
  } finally {
    await hub.close();
  }
  // Unreachable hub → [] (never throws).
  assert.deepEqual(await listArtifacts("http://127.0.0.1:1", 7), []);
});

test("fetchContainerFiles drops folders and degrades to [] on error", async () => {
  const hub = await fakeHub();
  try {
    assert.deepEqual(await fetchContainerFiles(hub.url, 5), [{ path: "my-artifact.zip", size: ZIP.length }]);
    assert.deepEqual(await fetchContainerFiles(hub.url, 999), []);
  } finally {
    await hub.close();
  }
});

test("resolveArtifact finds by name or numeric id, else null", async () => {
  const hub = await fakeHub();
  try {
    const byName = await resolveArtifact(hub.url, 7, "my-artifact");
    assert.equal(byName?.id, 5);
    assert.equal(byName?.files.length, 1);
    const byId = await resolveArtifact(hub.url, 7, "5");
    assert.equal(byId?.name, "my-artifact");
    assert.equal(await resolveArtifact(hub.url, 7, "nope"), null);
    assert.equal(await resolveArtifact(hub.url, 9, "my-artifact"), null);
    assert.equal(await resolveArtifact("http://127.0.0.1:1", 7, "my-artifact"), null);
  } finally {
    await hub.close();
  }
});

test("serveArtifactDownload streams the archive with an attachment filename", async () => {
  const hub = await fakeHub();
  try {
    const ok = await fetchThrough((req, res) => serveArtifactDownload(hub.url, 7, "my-artifact", res), "/");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/zip");
    assert.equal(ok.headers.get("content-disposition"), 'attachment; filename="my-artifact.zip"');
    assert.equal(ok.headers.get("content-length"), String(ZIP.length));
    assert.deepEqual(ok.buf, ZIP);
  } finally {
    await hub.close();
  }
});

test("serveArtifactDownload 404s an unknown artifact and 502s a failed blob read", async () => {
  const hub = await fakeHub();
  try {
    const missing = await fetchThrough((req, res) => serveArtifactDownload(hub.url, 7, "ghost", res), "/");
    assert.equal(missing.status, 404);
    const broken = await fetchThrough((req, res) => serveArtifactDownload(hub.url, 40, "bad", res), "/");
    assert.equal(broken.status, 502);
    const unreachable = await fetchThrough((req, res) => serveArtifactDownload("http://127.0.0.1:1", 7, "my-artifact", res), "/");
    // Unreachable = resolve returns null (no list) → 404.
    assert.equal(unreachable.status, 404);
  } finally {
    await hub.close();
  }
});

test("downloadArtifact writes the file(s) to disk; null for a missing artifact; throws on blob failure", async () => {
  const hub = await fakeHub();
  const out = mkdtempSync(join(tmpdir(), "ndh-art-"));
  try {
    const res = await downloadArtifact(hub.url, 7, "my-artifact", out);
    assert.equal(res?.name, "my-artifact");
    assert.equal(res?.written.length, 1);
    assert.deepEqual(readFileSync(res!.written[0]), ZIP);
    assert.equal(res!.written[0], join(out, "my-artifact.zip"));

    assert.equal(await downloadArtifact(hub.url, 7, "ghost", out), null);
    await assert.rejects(() => downloadArtifact(hub.url, 40, "bad", out), /download failed/);
  } finally {
    await hub.close();
  }
});
