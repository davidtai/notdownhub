import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { startFront, __test as gate } from "../front.js";
import { __test as fl } from "../filelog.js";
import { freshHome, startServer, body, type Fixture } from "./helpers.js";

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function req(port: number, path: string, headers: Record<string, string> = {}, host = "127.0.0.1"): Promise<Resp> {
  return reqm(port, "GET", path, headers, host);
}

function reqm(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  host = "127.0.0.1",
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port, path, method, headers }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end();
  });
}

async function front(opts: {
  hubPort: number;
  uiDir?: string | null;
  runnerToken?: string;
  host?: string;
  basicAuth?: string;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = startFront({ port: 0, uiDir: null, ...opts });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

test("mirror: cache hit serves the file without touching the network", async () => {
  const home = freshHome();
  const cache = join(home, "mirror", "owner", "repo", "tarball-main.tgz");
  mkdirSync(join(cache, ".."), { recursive: true });
  writeFileSync(cache, "cached-archive-bytes");
  const f = await front({ hubPort: 1 }); // hubPort unused for mirror
  try {
    const res = await req(f.port, "/mirror/owner/repo/tarball/main");
    assert.equal(res.status, 200);
    assert.equal(res.body, "cached-archive-bytes");
    assert.equal(res.headers["content-type"], "application/octet-stream");
  } finally {
    await f.close();
  }
});

test("mirror: cache miss fetches upstream (NDH_MIRROR_UPSTREAM), caches, and serves", async () => {
  const home = freshHome();
  let hits = 0;
  const up = await startServer((rq, res) => {
    hits++;
    assert.equal(rq.url, "/repos/owner/repo/tarball/v1");
    res.writeHead(200);
    res.end("fresh-from-upstream");
  });
  process.env.NDH_MIRROR_UPSTREAM = up.url;
  const f = await front({ hubPort: 1 });
  try {
    const res = await req(f.port, "/mirror/owner/repo/tarball/v1");
    assert.equal(res.status, 200);
    assert.equal(res.body, "fresh-from-upstream");
    assert.equal(hits, 1);
    assert.ok(existsSync(join(home, "mirror", "owner", "repo", "tarball-v1.tgz")), "should cache");
  } finally {
    delete process.env.NDH_MIRROR_UPSTREAM;
    await f.close();
    await up.close();
  }
});

test("mirror: upstream failure yields 502", async () => {
  freshHome();
  const up = await startServer((_rq, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  process.env.NDH_MIRROR_UPSTREAM = up.url;
  const f = await front({ hubPort: 1 });
  try {
    const res = await req(f.port, "/mirror/owner/repo/tarball/x");
    assert.equal(res.status, 502);
    assert.match(res.body, /mirror fetch failed/);
  } finally {
    delete process.env.NDH_MIRROR_UPSTREAM;
    await f.close();
    await up.close();
  }
});

test("mirror: malformed path yields 404", async () => {
  freshHome();
  const f = await front({ hubPort: 1 });
  try {
    const res = await req(f.port, "/mirror/not-enough-parts");
    assert.equal(res.status, 404);
    assert.match(res.body, /bad mirror path/);
  } finally {
    await f.close();
  }
});

interface Seen {
  host?: string;
  auth?: string;
  url?: string;
}
interface FakeHub extends Fixture {
  state: { registrations: number; last: Seen[] };
}

/** Fake hub: records requests, mints a JWT on registration, echoes for everything else. */
async function fakeHub(mint: { token?: string | null; regStatus?: number } = {}): Promise<FakeHub> {
  const state = { registrations: 0, last: [] as Seen[] };
  const fx = await startServer(async (rq, res) => {
    if (rq.url === "/api/v3/actions/runner-registration" && rq.method === "POST") {
      state.registrations++;
      await body(rq);
      if (mint.regStatus && mint.regStatus >= 400) {
        res.writeHead(mint.regStatus);
        res.end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(mint.token === null ? {} : { token: mint.token ?? "jwt-abc" }));
      return;
    }
    state.last.push({ host: rq.headers.host, auth: rq.headers.authorization as string, url: rq.url });
    res.writeHead(200);
    res.end("proxied-ok");
  });
  return { ...fx, state };
}

test("proxy: preserves Host verbatim and injects a minted Bearer on anonymous GET Agent* only", async () => {
  freshHome();
  const hub = await fakeHub({ token: "jwt-abc" });
  const f = await front({ hubPort: hub.port, runnerToken: "reg-token" });
  try {
    const res = await req(f.port, "/_apis/v1/Agent/1", { host: "public.example:4949" });
    assert.equal(res.status, 200);
    assert.equal(res.body, "proxied-ok");
    const seen = hub.state.last.at(-1)!;
    assert.equal(seen.host, "public.example:4949", "Host header must pass through untouched");
    assert.equal(seen.auth, "Bearer jwt-abc", "bearer minted + injected");
  } finally {
    await f.close();
    await hub.close();
  }
});

test("proxy: does NOT overwrite a client-provided Authorization on Agent paths", async () => {
  freshHome();
  const hub = await fakeHub({ token: "jwt-abc" });
  const f = await front({ hubPort: hub.port, runnerToken: "reg-token" });
  try {
    await req(f.port, "/_apis/v1/AgentPools/", { authorization: "Bearer client-own" });
    const seen = hub.state.last.at(-1)!;
    assert.equal(seen.auth, "Bearer client-own");
    assert.equal(hub.state.registrations, 0, "no mint when client authed");
  } finally {
    await f.close();
    await hub.close();
  }
});

test("proxy: non-Agent GET is not given a bearer", async () => {
  freshHome();
  const hub = await fakeHub({ token: "jwt-abc" });
  const f = await front({ hubPort: hub.port, runnerToken: "reg-token" });
  try {
    await req(f.port, "/_apis/v1/Message/workflow/runs?page=0");
    const seen = hub.state.last.at(-1)!;
    assert.equal(seen.auth, undefined);
    assert.equal(hub.state.registrations, 0);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("proxy: injects a minted Bearer on an anonymous DELETE to an Agent instance (unregister)", async () => {
  freshHome();
  const hub = await fakeHub({ token: "jwt-del" });
  const f = await front({ hubPort: hub.port, runnerToken: "reg-token" });
  try {
    const res = await reqm(f.port, "DELETE", "/_apis/v1/Agent/1/42", { host: "public.example:4949" });
    assert.equal(res.status, 200);
    const seen = hub.state.last.at(-1)!;
    assert.equal(seen.host, "public.example:4949", "Host header must pass through untouched");
    assert.equal(seen.auth, "Bearer jwt-del", "bearer minted + injected for the agent DELETE");
  } finally {
    await f.close();
    await hub.close();
  }
});

test("proxy: does NOT inject a Bearer on a DELETE to a non-Agent path", async () => {
  freshHome();
  const hub = await fakeHub({ token: "jwt-del" });
  const f = await front({ hubPort: hub.port, runnerToken: "reg-token" });
  try {
    await reqm(f.port, "DELETE", "/_apis/v1/Message/workflow/run/1");
    const seen = hub.state.last.at(-1)!;
    assert.equal(seen.auth, undefined);
    assert.equal(hub.state.registrations, 0, "no mint for a non-agent DELETE");
  } finally {
    await f.close();
    await hub.close();
  }
});

test("proxy: management JWT is cached across requests (single registration)", async () => {
  freshHome();
  const hub = await fakeHub({ token: "jwt-abc" });
  const f = await front({ hubPort: hub.port, runnerToken: "reg-token" });
  try {
    await req(f.port, "/_apis/v1/Agent/1");
    await req(f.port, "/_apis/v1/Agent/2");
    assert.equal(hub.state.registrations, 1, "JWT cached");
  } finally {
    await f.close();
    await hub.close();
  }
});

test("proxy: failed mint (registration !ok) proxies without a bearer", async () => {
  freshHome();
  const hub = await fakeHub({ regStatus: 401 });
  const f = await front({ hubPort: hub.port }); // no runnerToken -> RemoteAuth none
  try {
    const res = await req(f.port, "/_apis/v1/Agent/1");
    assert.equal(res.status, 200);
    const seen = hub.state.last.at(-1)!;
    assert.equal(seen.auth, undefined);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("proxy: streams a chunked body through unmodified", async () => {
  freshHome();
  const hub = await startServer((_rq, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("chunk-1;");
    setTimeout(() => {
      res.write("chunk-2;");
      res.end("chunk-3");
    }, 20);
  });
  const f = await front({ hubPort: hub.port });
  try {
    const res = await req(f.port, "/stream");
    assert.equal(res.body, "chunk-1;chunk-2;chunk-3");
  } finally {
    await f.close();
    await hub.close();
  }
});

test("proxy: a dead hub yields 502 hub unavailable", async () => {
  freshHome();
  // find a port with nothing listening
  const probe = await startServer(() => {});
  const deadPort = probe.port;
  await probe.close();
  const f = await front({ hubPort: deadPort });
  try {
    const res = await req(f.port, "/anything");
    assert.equal(res.status, 502);
    assert.match(res.body, /hub unavailable/);
  } finally {
    await f.close();
  }
});

test("serveUi: serves index, correct mime, SPA fallback; reserves API prefixes for the proxy", async () => {
  freshHome();
  const uiDir = mkdtempSync(join(tmpdir(), "ndh-ui-"));
  writeFileSync(join(uiDir, "index.html"), "<h1>ndh</h1>");
  writeFileSync(join(uiDir, "app.js"), "console.log(1)");
  const hub = await startServer((_rq, res) => {
    res.writeHead(200);
    res.end("from-hub");
  });
  const f = await front({ hubPort: hub.port, uiDir });
  try {
    assert.equal((await req(f.port, "/")).body, "<h1>ndh</h1>");
    const js = await req(f.port, "/app.js");
    assert.equal(js.headers["content-type"], "text/javascript");
    assert.equal((await req(f.port, "/some/spa/route")).body, "<h1>ndh</h1>", "SPA fallback");
    // API-ish prefixes are reserved -> proxied to the hub, not served from disk
    assert.equal((await req(f.port, "/api/whatever")).body, "from-hub");
    assert.equal((await req(f.port, "/_apis/v1/x")).body, "from-hub");
  } finally {
    await f.close();
    await hub.close();
  }
});

test("join-info: loopback client gets host/port/token/authEnabled", async () => {
  freshHome();
  const hub = await startServer((_rq, res) => res.end("x"));
  const f = await front({ hubPort: hub.port, host: "hub.local", runnerToken: "tok-123" });
  try {
    const res = await req(f.port, "/api/local/join-info");
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);
    // port reflects the *configured* FrontOptions.port (0 here, since we bind ephemerally in tests)
    assert.deepEqual(j, { host: "hub.local", port: 0, token: "tok-123", authEnabled: true });
  } finally {
    await f.close();
    await hub.close();
  }
});

test("join-info: defaults host to localhost and authEnabled false without a token", async () => {
  freshHome();
  const hub = await startServer((_rq, res) => res.end("x"));
  const f = await front({ hubPort: hub.port });
  try {
    const j = JSON.parse((await req(f.port, "/api/local/join-info")).body);
    assert.equal(j.host, "localhost");
    assert.equal(j.token, null);
    assert.equal(j.authEnabled, false);
  } finally {
    await f.close();
    await hub.close();
  }
});

// ---------- UI access gates (unit-tested with synthetic requests: deterministic, no LAN needed) ----------

function fakeReq(remoteAddress: string, authorization?: string): http.IncomingMessage {
  return { socket: { remoteAddress }, headers: authorization ? { authorization } : {} } as never;
}

test("isLoopback recognizes v4/v6 loopback and rejects the rest", () => {
  assert.equal(gate.isLoopback("127.0.0.1"), true);
  assert.equal(gate.isLoopback("::1"), true);
  assert.equal(gate.isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(gate.isLoopback("192.168.1.5"), false);
  assert.equal(gate.isLoopback(undefined), false);
});

test("basicAuthOk is a length-safe exact match", () => {
  const cred = "Basic " + Buffer.from("user:pass").toString("base64");
  assert.equal(gate.basicAuthOk(fakeReq("x", cred), "user:pass"), true);
  assert.equal(gate.basicAuthOk(fakeReq("x", cred), "user:wrong"), false);
  assert.equal(gate.basicAuthOk(fakeReq("x", "Bearer foo"), "user:pass"), false);
  assert.equal(gate.basicAuthOk(fakeReq("x"), "user:pass"), false);
});

test("uiAccessAllowed: loopback always; non-loopback needs correct basic auth", () => {
  const cred = "Basic " + Buffer.from("u:p").toString("base64");
  assert.equal(gate.uiAccessAllowed(fakeReq("127.0.0.1"), { basicAuth: undefined } as never), true);
  assert.equal(gate.uiAccessAllowed(fakeReq("10.0.0.9"), { basicAuth: undefined } as never), false);
  assert.equal(gate.uiAccessAllowed(fakeReq("10.0.0.9", cred), { basicAuth: "u:p" } as never), true);
  assert.equal(gate.uiAccessAllowed(fakeReq("10.0.0.9", "Basic bad"), { basicAuth: "u:p" } as never), false);
});

test("denyUi: 401+challenge when basic auth configured, else 403", () => {
  const cap = () => {
    const rec: { code?: number; headers?: object; body?: string } = {};
    const res = {
      writeHead(code: number, headers?: object) {
        rec.code = code;
        rec.headers = headers;
      },
      end(b: string) {
        rec.body = b;
      },
    } as never as http.ServerResponse;
    return { res, rec };
  };
  const a = cap();
  gate.denyUi(a.res, { basicAuth: "u:p" } as never);
  assert.equal(a.rec.code, 401);
  assert.match(String((a.rec.headers as Record<string, string>)["www-authenticate"]), /Basic realm/);
  const b = cap();
  gate.denyUi(b.res, { basicAuth: undefined } as never);
  assert.equal(b.rec.code, 403);
});

test("isUiPath excludes proxy/mirror prefixes", () => {
  assert.equal(gate.isUiPath("/dashboard"), true);
  assert.equal(gate.isUiPath("/_apis/x"), false);
  assert.equal(gate.isUiPath("/runner/server"), false);
  assert.equal(gate.isUiPath("/api/local/join-info"), false);
  assert.equal(gate.isUiPath("/mirror/o/r/tarball/v"), false);
});

// The request router's access-gate branches, driven with synthetic non-loopback requests so they
// are deterministic (no dependency on the host having a routable LAN IP).
interface CapRes {
  res: http.ServerResponse;
  rec: { code?: number; headers?: Record<string, string>; body?: string; statusCode?: number };
}
function capRes(): CapRes {
  const rec: CapRes["rec"] = {};
  const res = {
    set statusCode(v: number) {
      rec.statusCode = v;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      rec.code = code;
      rec.headers = headers;
    },
    end(b?: string) {
      rec.body = b;
    },
  } as never as http.ServerResponse;
  return { res, rec };
}
function synthReq(remoteAddress: string, url: string, headers: Record<string, string> = {}, method = "GET") {
  return { socket: { remoteAddress }, headers, url, method } as never as http.IncomingMessage;
}
const noMint = async () => null;

test("handleRequest: join-info is denied for a non-loopback client without basic auth (403)", async () => {
  const c = capRes();
  await gate.handleRequest(synthReq("10.1.2.3", "/api/local/join-info"), c.res, { basicAuth: undefined } as never, noMint);
  assert.equal(c.rec.code, 403);
});

test("handleRequest: join-info challenges (401) then allows (200) with correct basic auth", async () => {
  const bad = capRes();
  await gate.handleRequest(
    synthReq("10.1.2.3", "/api/local/join-info"),
    bad.res,
    { basicAuth: "u:p", port: 4949, host: "h", runnerToken: "t" } as never,
    noMint,
  );
  assert.equal(bad.rec.code, 401);

  const ok = capRes();
  await gate.handleRequest(
    synthReq("10.1.2.3", "/api/local/join-info", { authorization: "Basic " + Buffer.from("u:p").toString("base64") }),
    ok.res,
    { basicAuth: "u:p", port: 4949, host: "h", runnerToken: "t" } as never,
    noMint,
  );
  assert.equal(ok.rec.code, 200);
  assert.deepEqual(JSON.parse(ok.rec.body!), { host: "h", port: 4949, token: "t", authEnabled: true });
});

test("handleRequest: a non-loopback UI page request is denied", async () => {
  const c = capRes();
  await gate.handleRequest(
    synthReq("10.1.2.3", "/dashboard"),
    c.res,
    { uiDir: "/tmp/ui", basicAuth: undefined } as never,
    noMint,
  );
  assert.equal(c.rec.code, 403);
});

test("handleRequest: an unexpected error becomes a 500", async () => {
  const c = capRes();
  const badReq = {
    get url(): string {
      throw new Error("boom");
    },
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  } as never as http.IncomingMessage;
  await gate.handleRequest(badReq, c.res, {} as never, noMint);
  assert.equal(c.rec.statusCode, 500);
  assert.match(c.rec.body!, /boom/);
});

// ---------- Artifacts: list / download through the front, and the printed-URL resolve route ----------

const ART_ZIP = Buffer.from("PKfront-artifact-zip");

/** Fake hub speaking the v3 pipelines artifact API (run 7 has one artifact "my-artifact"). */
function artifactHub(): Promise<Fixture> {
  return startServer((rq, rs) => {
    const u = new URL(rq.url ?? "/", "http://x");
    const j = (b: unknown) => {
      rs.writeHead(200, { "content-type": "application/json" });
      rs.end(JSON.stringify(b));
    };
    if (u.pathname === "/_apis/pipelines/workflows/7/artifacts") j({ value: [{ containerId: 5, size: 0, name: "my-artifact" }] });
    else if (u.pathname === "/_apis/pipelines/workflows/container/5")
      j({ value: [{ path: "my-artifact.zip", itemType: "file", fileLength: ART_ZIP.length }] });
    else if (u.pathname === "/_apis/pipelines/workflows/artifact/5") {
      rs.writeHead(200);
      rs.end(ART_ZIP);
    } else {
      rs.writeHead(404);
      rs.end("no");
    }
  });
}

test("front: GET /api/local/artifacts/<run> lists a run's artifacts (loopback)", async () => {
  const hub = await artifactHub();
  const f = await front({ hubPort: hub.port });
  try {
    const res = await req(f.port, "/api/local/artifacts/7");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), [{ id: 5, name: "my-artifact", size: ART_ZIP.length }]);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("front: GET /api/local/artifacts/<run>/<name> streams the archive as an attachment", async () => {
  const hub = await artifactHub();
  const f = await front({ hubPort: hub.port });
  try {
    const res = await req(f.port, "/api/local/artifacts/7/my-artifact");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-disposition"], 'attachment; filename="my-artifact.zip"');
    assert.equal(res.body, ART_ZIP.toString());
  } finally {
    await f.close();
    await hub.close();
  }
});

test("front: the printed artifact URL /<o>/<r>/actions/runs/<run>/artifacts/<id> resolves to the archive", async () => {
  const hub = await artifactHub();
  const f = await front({ hubPort: hub.port });
  try {
    const res = await req(f.port, "/local/repro/actions/runs/7/artifacts/5");
    assert.equal(res.status, 200);
    assert.equal(res.body, ART_ZIP.toString());
  } finally {
    await f.close();
    await hub.close();
  }
});

test("front: the raw /_apis artifact endpoints still proxy (runner upload + direct download unaffected)", async () => {
  const hub = await artifactHub();
  const f = await front({ hubPort: hub.port });
  try {
    // Same path the runner uploads to and the CLI downloads from — must reach the hub, never be UI-gated.
    const res = await req(f.port, "/_apis/pipelines/workflows/7/artifacts");
    assert.equal(res.status, 200);
    assert.match(res.body, /my-artifact/);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("handleRequest: artifact list, download, and the printed URL are all UI-gated for non-loopback", async () => {
  for (const path of ["/api/local/artifacts/7", "/api/local/artifacts/7/my-artifact", "/local/repro/actions/runs/7/artifacts/5"]) {
    const c = capRes();
    await gate.handleRequest(synthReq("10.9.9.9", path), c.res, { hubPort: 1, basicAuth: undefined } as never, noMint);
    assert.equal(c.rec.code, 403, `${path} should be denied for non-loopback`);
  }
});

test("handleRequest: artifact download is served to an authenticated remote (basic auth)", async () => {
  const hub = await artifactHub();
  try {
    const c = capRes();
    await gate.handleRequest(
      synthReq("10.9.9.9", "/api/local/artifacts/7", { authorization: "Basic " + Buffer.from("u:p").toString("base64") }),
      c.res,
      { hubPort: hub.port, basicAuth: "u:p" } as never,
      noMint,
    );
    assert.equal(c.rec.code, 200);
    assert.deepEqual(JSON.parse(c.rec.body!), [{ id: 5, name: "my-artifact", size: ART_ZIP.length }]);
  } finally {
    await hub.close();
  }
});

test.after(() => fl.reset());
