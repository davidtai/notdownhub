import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { startFront } from "../front.js";
import { treeCacheDir, treeKey, hasCompleteTree, serveTree, dropTree } from "../treecache.js";
import { startServer, freshHome, type Fixture } from "./helpers.js";

// #110 tree retention: the dispatched tree streams through the front exactly once (the original
// attempt's checkout); the front tees it into a per-run cache and serves identical requests from
// that cache — which is how a replayed re-run attempt checks out after the dispatch client exited.

const TREE_BODY = 'preamble\r\n--BOUND\r\nContent-Disposition: form-data; name="644:README.md"; filename="README.md"\r\n\r\nhello\r\n--BOUND--\r\n';
const TREE_TYPE = 'multipart/form-data; boundary="BOUND"';

function front(hubPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = startFront({ port: 0, hubPort, uiDir: null });
    server.once("listening", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function get(port: number, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: b }),
        );
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/** A fake engine that serves the multipart tree, counting how often it was asked. */
function fakeEngine(hits: { n: number }): Promise<Fixture> {
  return startServer((req, res) => {
    if ((req.url ?? "").includes("/_apis/v1/Message/multipart/")) {
      hits.n++;
      res.writeHead(200, { "content-type": TREE_TYPE });
      res.end(TREE_BODY);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

test("treeKey: normalized flags and encoded repositoryAndRef", () => {
  assert.equal(treeKey(new URLSearchParams()), "submodules=false&nested=false&repo=");
  assert.equal(
    treeKey(new URLSearchParams("submodules=true&nestedSubmodules=true")),
    "submodules=true&nested=true&repo=",
  );
  // Anything not exactly "true" is false; the foreign repo@ref is a safe file segment.
  const k = treeKey(new URLSearchParams("submodules=1&repositoryAndRef=acme%2Flib%40v1.2"));
  assert.equal(k, "submodules=false&nested=false&repo=acme%2Flib%40v1%2E2");
});

test("first GET tees the stream into the cache; the next GET is served without the engine", async () => {
  freshHome();
  const hits = { n: 0 };
  const engine = await fakeEngine(hits);
  const f = await front(engine.port);
  try {
    const first = await get(f.port, "/_apis/v1/Message/multipart/42?submodules=false&nestedSubmodules=false");
    assert.equal(first.status, 200);
    assert.equal(first.body, TREE_BODY);
    assert.equal(first.type, TREE_TYPE);
    assert.equal(hits.n, 1);
    assert.equal(await hasCompleteTree(42), true);

    // The engine is GONE (dispatch client exited) — the cache alone serves the replay's checkout.
    await engine.close();
    const second = await get(f.port, "/_apis/v1/Message/multipart/42?submodules=false&nestedSubmodules=false");
    assert.equal(second.status, 200);
    assert.equal(second.body, TREE_BODY);
    assert.equal(second.type, TREE_TYPE);
    assert.equal(hits.n, 1);
  } finally {
    await f.close();
    await engine.close().catch(() => {});
  }
});

test("a tenant-prefixed multipart path is intercepted too (suffix match)", async () => {
  freshHome();
  const hits = { n: 0 };
  const engine = await fakeEngine(hits);
  const f = await front(engine.port);
  try {
    const r = await get(f.port, "/acme/widget/_apis/v1/Message/multipart/7?submodules=false");
    assert.equal(r.status, 200);
    assert.equal(await hasCompleteTree(7), true);
  } finally {
    await f.close();
    await engine.close();
  }
});

test("a different request shape misses the cache and goes back to the engine", async () => {
  freshHome();
  const hits = { n: 0 };
  const engine = await fakeEngine(hits);
  const f = await front(engine.port);
  try {
    await get(f.port, "/_apis/v1/Message/multipart/9");
    assert.equal(hits.n, 1);
    await get(f.port, "/_apis/v1/Message/multipart/9?submodules=true");
    assert.equal(hits.n, 2); // submodules=true is a distinct tree
    await get(f.port, "/_apis/v1/Message/multipart/9?repositoryAndRef=acme%2Flib%40main");
    assert.equal(hits.n, 3); // foreign repo@ref is a distinct tree
    await get(f.port, "/_apis/v1/Message/multipart/9");
    assert.equal(hits.n, 3); // the original shape is cached
  } finally {
    await f.close();
    await engine.close();
  }
});

test("a non-200 engine answer passes through and caches nothing", async () => {
  freshHome();
  const engine = await startServer((_req, res) => {
    res.writeHead(404);
    res.end("no");
  });
  const f = await front(engine.port);
  try {
    const r = await get(f.port, "/_apis/v1/Message/multipart/13");
    assert.equal(r.status, 404);
    assert.equal(await hasCompleteTree(13), false);
  } finally {
    await f.close();
    await engine.close();
  }
});

test("a stream that dies mid-tee leaves no (half) cache entry", async () => {
  freshHome();
  const engine = await startServer((req, res) => {
    if ((req.url ?? "").includes("/multipart/")) {
      res.writeHead(200, { "content-type": TREE_TYPE, "content-length": String(TREE_BODY.length) });
      res.write(TREE_BODY.slice(0, 10));
      setTimeout(() => res.destroy(), 10); // upstream dies before the body completes
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const f = await front(engine.port);
  try {
    await get(f.port, "/_apis/v1/Message/multipart/21").catch(() => {});
    // Give the discard path a beat to unlink the temp file.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await hasCompleteTree(21), false);
    const dir = join(treeCacheDir(), "21");
    const leftovers = existsSync(dir) ? readdirSync(dir) : [];
    assert.deepEqual(leftovers, []); // no .part debris either
  } finally {
    await f.close();
    await engine.close();
  }
});

test("hasCompleteTree demands the meta marker, not just data bytes", async () => {
  freshHome();
  const dir = join(treeCacheDir(), "77");
  mkdirSync(dir, { recursive: true });
  const key = treeKey(new URLSearchParams());
  writeFileSync(join(dir, `${key}.multipart`), "data");
  assert.equal(await hasCompleteTree(77), false); // data without meta = incomplete
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({ contentType: TREE_TYPE }));
  assert.equal(await hasCompleteTree(77), true);
});

test("serveTree: corrupt meta or missing data refuse to serve (caller proxies)", async () => {
  freshHome();
  const dir = join(treeCacheDir(), "78");
  mkdirSync(dir, { recursive: true });
  const key = treeKey(new URLSearchParams());
  const res = { writeHead: () => {}, on: () => {} } as unknown as http.ServerResponse;
  writeFileSync(join(dir, `${key}.json`), "not json");
  assert.equal(await serveTree(78, new URLSearchParams(), res), false);
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({ contentType: TREE_TYPE }));
  assert.equal(await serveTree(78, new URLSearchParams(), res), false); // meta ok, data missing
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({ contentType: "" }));
  writeFileSync(join(dir, `${key}.multipart`), "data");
  assert.equal(await serveTree(78, new URLSearchParams(), res), false); // empty content-type
});

test("dropTree removes a run's retained trees; missing runs are a no-op", async () => {
  freshHome();
  const dir = join(treeCacheDir(), "80");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "x.multipart"), "data");
  await dropTree(80);
  assert.equal(existsSync(dir), false);
  await dropTree(80); // idempotent
});

test("an unreachable engine yields 502 (nothing cached)", async () => {
  freshHome();
  const engine = await startServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  await engine.close(); // port is now dead
  const f = await front(engine.port);
  try {
    const r = await get(f.port, "/_apis/v1/Message/multipart/31");
    assert.equal(r.status, 502);
    assert.equal(await hasCompleteTree(31), false);
  } finally {
    await f.close();
  }
});
