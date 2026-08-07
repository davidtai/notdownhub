import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFront, type FrontOptions, __test as frontTest } from "../front.js";
import { __test as hubTest } from "../hub.js";

// Every test runs under an isolated NDH_HOME (also enforced globally by _setup.ts) so the
// mirror cache never touches the real ~/.notdownhub.
function freshHome(): string {
  process.env.NDH_HOME = mkdtempSync(join(tmpdir(), "ndh-front-"));
  return process.env.NDH_HOME;
}

// A one-shot HTTP request that does NOT keep its socket in the global agent pool.
function req(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

function hardClose(server: http.Server): void {
  server.closeAllConnections?.();
  server.close();
}

function startTestFront(opts: Partial<FrontOptions> = {}): { server: http.Server; port: number } {
  const server = startFront({ port: 0, hubPort: 1, uiDir: null, ...opts });
  return { server, port: (server.address() as { port: number }).port };
}

function fakeUpstream(bodyFor: (p: string) => string, delayMs = 0) {
  let fetches = 0;
  const auth: (string | undefined)[] = [];
  const server = http.createServer((r, res) => {
    fetches++;
    auth.push(r.headers.authorization);
    const body = bodyFor(r.url ?? "");
    setTimeout(() => {
      res.writeHead(200);
      res.end(body);
    }, delayMs);
  });
  return { server, get fetches() { return fetches; }, auth };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, r));
  return (server.address() as { port: number }).port;
}

test("encodeSeg: slashed and underscored refs never collide", () => {
  const { encodeSeg } = frontTest;
  assert.notEqual(encodeSeg("feature/x"), encodeSeg("feature_x"));
  assert.notEqual(encodeSeg("v1.2"), encodeSeg("v1_2"));
  assert.ok(!encodeSeg("feature/x").includes("/"));
  assert.equal(decodeURIComponent(encodeSeg("release/v1.2")), "release/v1.2");
});

test("isValidPort", () => {
  assert.ok(hubTest.isValidPort(4949) && hubTest.isValidPort(1) && hubTest.isValidPort(65535));
  assert.ok(!hubTest.isValidPort(Number("abc")) && !hubTest.isValidPort(0) && !hubTest.isValidPort(70000));
});

test("mirror: distinct refs with slashes do not collide, each fetched once", async () => {
  const home = freshHome();
  const up = fakeUpstream((p) => `ARCHIVE${p}`);
  const upPort = await listen(up.server);
  process.env.NDH_MIRROR_UPSTREAM = `http://127.0.0.1:${upPort}`;
  const front = startTestFront();
  try {
    const a = await req(front.port, "/mirror/o/r/tarball/feature/x");
    const b = await req(front.port, "/mirror/o/r/tarball/feature_x");
    assert.equal(a.status, 200);
    assert.notEqual(a.body, b.body);
    assert.equal(up.fetches, 2);
    assert.equal((await readdir(join(home, "mirror", "o", "r"))).length, 2);
  } finally {
    hardClose(front.server);
    hardClose(up.server);
    delete process.env.NDH_MIRROR_UPSTREAM;
  }
});

test("mirror: concurrent misses for one ref coalesce into a single fetch", async () => {
  freshHome();
  const up = fakeUpstream(() => "THE-ARCHIVE", 60);
  const upPort = await listen(up.server);
  process.env.NDH_MIRROR_UPSTREAM = `http://127.0.0.1:${upPort}`;
  const front = startTestFront();
  try {
    const rs = await Promise.all([0, 1, 2].map(() => req(front.port, "/mirror/o/r/tarball/v1")));
    assert.ok(rs.every((r) => r.body === "THE-ARCHIVE"));
    assert.equal(up.fetches, 1);
  } finally {
    hardClose(front.server);
    hardClose(up.server);
    delete process.env.NDH_MIRROR_UPSTREAM;
  }
});

test("mirror: --github-token authenticates the fetch", async () => {
  freshHome();
  const up = fakeUpstream(() => "AUTHED");
  const upPort = await listen(up.server);
  process.env.NDH_MIRROR_UPSTREAM = `http://127.0.0.1:${upPort}`;
  delete process.env.GITHUB_TOKEN;
  const front = startTestFront({ githubToken: "ghp_test123" });
  try {
    await req(front.port, "/mirror/o/r/tarball/v1");
    assert.equal(up.auth[0], "token ghp_test123");
  } finally {
    hardClose(front.server);
    hardClose(up.server);
    delete process.env.NDH_MIRROR_UPSTREAM;
  }
});

test("proxy: hub unreachable → clean 502 before headers", async () => {
  freshHome();
  const front = startTestFront();
  try {
    const r = await req(front.port, "/_apis/v1/whatever");
    assert.equal(r.status, 502);
    assert.match(r.body, /hub unavailable/);
  } finally {
    hardClose(front.server);
  }
});

test("proxy: upstream drop mid-stream resets the client (no hang, no junk body)", async () => {
  freshHome();
  const hub = http.createServer((_r, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("chunk-1");
    setTimeout(() => res.socket?.destroy(), 20);
  });
  const hubPort = await listen(hub);
  const front = startTestFront({ hubPort });
  try {
    const outcome = await new Promise<string>((resolve) => {
      const r = http.get({ host: "127.0.0.1", port: front.port, path: "/_apis/v1/stream", agent: false }, (res) => {
        let got = "";
        res.on("data", (d) => (got += d));
        res.on("aborted", () => resolve(`aborted:${got}`));
        res.on("end", () => resolve(`end:${got}`));
        res.on("error", () => resolve(`error:${got}`));
      });
      r.on("error", () => resolve("reqerror"));
      setTimeout(() => resolve("HANG"), 1500);
    });
    assert.notEqual(outcome, "HANG");
    assert.ok(!outcome.includes("hub unavailable"), "no 502 body injected mid-stream");
  } finally {
    hardClose(front.server);
    hardClose(hub);
  }
});

// Regression: runner-served paths must NOT be treated as local-only UI (else remote runners 403).
test("isUiPath: hub/runner paths proxy; /localcheckout and /twirp are never UI-gated", () => {
  const { isUiPath } = frontTest;
  for (const p of ["/_apis/v1/x", "/runner/server", "/api/local/agents", "/mirror/o/r/tarball/v1",
                   "/localcheckout.tar.gz", "/localcheckout.zip",
                   "/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry"]) {
    assert.equal(isUiPath(p), false, `${p} must proxy, not be UI-gated`);
  }
  for (const p of ["/", "/runs/12", "/assets/app.js", "/settings"]) {
    assert.equal(isUiPath(p), true, `${p} is a UI path`);
  }
});
