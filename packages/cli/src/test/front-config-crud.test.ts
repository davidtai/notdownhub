import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { startFront, __test as gate } from "../front.js";
import { parseScope } from "../config-crud.js";
import { getSecret, listSecrets } from "../secrets.js";
import { getVar, listVars } from "../vars.js";
import { freshHome, startServer, fakeSecurityDir, type Fixture } from "./helpers.js";

/*
  #145: POST/DELETE /api/local/secrets and /api/local/vars — the Settings-page
  write surface. These tests hit a real front server over loopback (store
  write-through, validation, idempotence, never-echo) and the extracted router
  with synthetic non-loopback requests (gating).
*/

function req(
  port: number,
  path: string,
  { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; allow?: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, allow: res.headers.allow }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const postJson = (port: number, path: string, payload: unknown) =>
  req(port, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

async function front(hubPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = startFront({ port: 0, uiDir: null, hubPort });
  await new Promise((r) => server.once("listening", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) };
}

async function withFront(fn: (port: number) => Promise<void>): Promise<void> {
  const hub: Fixture = await startServer((_q, r) => r.end());
  const f = await front(hub.port);
  try {
    await fn(f.port);
  } finally {
    await f.close();
    await hub.close();
  }
}

// ---- secrets: write-through + never-echo ----

test("POST /api/local/secrets: stores a MULTILINE value byte-exactly via the CLI store; no response echoes it", async () => {
  freshHome();
  const value = "-----BEGIN S3CRET-marker-----\nline two\n"; // trailing newline typed → kept
  await withFront(async (port) => {
    const res = await postJson(port, "/api/local/secrets", { name: "DEPLOY_KEY", value, scope: "global" });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.name, "DEPLOY_KEY");
    assert.equal(body.scope, "global");
    assert.equal(typeof body.backend, "string");
    // Never-echo: the write response carries no fragment of the value.
    assert.ok(!res.body.includes("S3CRET-marker"));
    assert.ok(!res.body.includes("line two"));

    // The store the CLI reads (same backend, same index) has the exact bytes.
    assert.equal(await getSecret("global", "DEPLOY_KEY"), value);
    assert.deepEqual(await listSecrets("global"), [{ name: "DEPLOY_KEY", scope: "global" }]);

    // Never-echo: the list read (GET /api/local/config) has the name, never the value.
    const cfg = await req(port, "/api/local/config");
    assert.equal(cfg.status, 200);
    assert.ok(cfg.body.includes("DEPLOY_KEY"));
    assert.ok(!cfg.body.includes("S3CRET-marker"));
    assert.ok(!cfg.body.includes("line two"));
  });
});

test("POST /api/local/secrets: repo scope is honored (owner/name), overriding nothing else", async () => {
  freshHome();
  await withFront(async (port) => {
    const res = await postJson(port, "/api/local/secrets", { name: "NPM_TOKEN", value: "v1", scope: "acme/api" });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).scope, "acme/api");
    assert.equal(await getSecret("acme/api", "NPM_TOKEN"), "v1");
    assert.equal(await getSecret("global", "NPM_TOKEN"), null);
  });
});

test("POST /api/local/secrets: omitted scope defaults to global (same as the CLI without --repo)", async () => {
  freshHome();
  await withFront(async (port) => {
    assert.equal((await postJson(port, "/api/local/secrets", { name: "TOKEN_A", value: "x" })).status, 200);
    assert.equal(await getSecret("global", "TOKEN_A"), "x");
  });
});

test("POST /api/local/secrets: the CLI's env-identifier name rule, as a 400 (hub stays alive)", async () => {
  freshHome();
  await withFront(async (port) => {
    for (const name of ["1BAD", "has-dash", "has space", "", "a.b"]) {
      const res = await postJson(port, "/api/local/secrets", { name, value: "v" });
      assert.equal(res.status, 400, `name ${JSON.stringify(name)} must 400`);
      assert.match(JSON.parse(res.body).error, /invalid name/);
    }
    assert.deepEqual(await listSecrets(), []); // nothing stored
    // The server survived every invalid write (fail() would have exited the process).
    assert.equal((await postJson(port, "/api/local/secrets", { name: "OK_1", value: "v" })).status, 200);
  });
});

test("POST /api/local/secrets: empty value, bad scope, and non-JSON bodies are 400s", async () => {
  freshHome();
  await withFront(async (port) => {
    let res = await postJson(port, "/api/local/secrets", { name: "A_OK", value: "" });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, "empty secret value");

    res = await postJson(port, "/api/local/secrets", { name: "A_OK", value: "v", scope: "not a slug" });
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /scope/);

    res = await req(port, "/api/local/secrets", { method: "POST", body: "not-json{" });
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /invalid JSON/);
    assert.deepEqual(await listSecrets(), []);
  });
});

test("DELETE /api/local/secrets: removes from the CLI store; idempotent (removed:true then removed:false)", async () => {
  freshHome();
  await withFront(async (port) => {
    await postJson(port, "/api/local/secrets", { name: "GONE_SOON", value: "bye" });
    assert.equal(await getSecret("global", "GONE_SOON"), "bye");

    const del1 = await req(port, "/api/local/secrets?name=GONE_SOON&scope=global", { method: "DELETE" });
    assert.equal(del1.status, 200);
    assert.deepEqual(JSON.parse(del1.body), { ok: true, name: "GONE_SOON", scope: "global", removed: true });
    assert.equal(await getSecret("global", "GONE_SOON"), null);
    assert.deepEqual(await listSecrets(), []);

    const del2 = await req(port, "/api/local/secrets?name=GONE_SOON&scope=global", { method: "DELETE" });
    assert.equal(del2.status, 200);
    assert.equal(JSON.parse(del2.body).removed, false);

    // Bad/missing name on DELETE is a 400, not a crash.
    assert.equal((await req(port, "/api/local/secrets?name=not%20valid", { method: "DELETE" })).status, 400);
    assert.equal((await req(port, "/api/local/secrets", { method: "DELETE" })).status, 400);
  });
});

test("GET/PUT /api/local/secrets: 405 with Allow — reads live on /api/local/config", async () => {
  freshHome();
  await withFront(async (port) => {
    const get = await req(port, "/api/local/secrets");
    assert.equal(get.status, 405);
    assert.equal(get.allow, "POST, DELETE");
    assert.equal((await req(port, "/api/local/secrets", { method: "PUT" })).status, 405);
  });
});

test("POST /api/local/secrets: a keychain write failure surfaces its message — incl. the #42 backend-file hint", async () => {
  freshHome();
  const savedPath = process.env.PATH;
  const savedBackend = process.env.NDH_SECRETS_BACKEND;
  process.env.PATH = `${fakeSecurityDir()}:${savedPath}`;
  process.env.NDH_SECRETS_BACKEND = "keychain";
  try {
    await withFront(async (port) => {
      const res = await postJson(port, "/api/local/secrets", { name: "WILL_FAIL", value: "FAILWRITE" });
      assert.equal(res.status, 500);
      const err = JSON.parse(res.body).error as string;
      assert.match(err, /keychain write failed: simulated failure/);
      assert.match(err, /ndh secrets backend file/); // the #42 hint passes through verbatim
      // A failed write never lands in the index the UI lists from.
      assert.deepEqual(await listSecrets(), []);
    });
  } finally {
    process.env.PATH = savedPath;
    process.env.NDH_SECRETS_BACKEND = savedBackend;
  }
});

// ---- vars: write-through (values are not secret) ----

test("POST /api/local/vars: stores via the CLI vars store; config lists the value; delete is idempotent", async () => {
  freshHome();
  await withFront(async (port) => {
    const res = await postJson(port, "/api/local/vars", { name: "DEPLOY_TARGET", value: "staging" });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, name: "DEPLOY_TARGET", scope: "global" });
    assert.equal(await getVar("global", "DEPLOY_TARGET"), "staging");

    // Vars are not secret — the list read shows the value.
    const cfg = await req(port, "/api/local/config");
    assert.ok(cfg.body.includes('"staging"'));

    const del1 = await req(port, "/api/local/vars?name=DEPLOY_TARGET", { method: "DELETE" });
    assert.equal(del1.status, 200);
    assert.equal(JSON.parse(del1.body).removed, true);
    assert.equal(await getVar("global", "DEPLOY_TARGET"), null);
    const del2 = await req(port, "/api/local/vars?name=DEPLOY_TARGET", { method: "DELETE" });
    assert.equal(JSON.parse(del2.body).removed, false);
  });
});

test("POST /api/local/vars: repo scope + byte-exact multiline value; validation mirrors the CLI", async () => {
  freshHome();
  await withFront(async (port) => {
    const value = "line1\nline2"; // stored exactly — no trailing newline appears
    assert.equal((await postJson(port, "/api/local/vars", { name: "NOTES", value, scope: "acme/web" })).status, 200);
    assert.equal(await getVar("acme/web", "NOTES"), value);
    assert.deepEqual(await listVars("acme/web"), [{ scope: "acme/web", name: "NOTES", value }]);

    assert.equal((await postJson(port, "/api/local/vars", { name: "bad name", value: "v" })).status, 400);
    const empty = await postJson(port, "/api/local/vars", { name: "V_OK", value: "" });
    assert.equal(empty.status, 400);
    assert.equal(JSON.parse(empty.body).error, "empty variable value");
    assert.equal((await req(port, "/api/local/vars")).status, 405);
  });
});

test("DELETE: a malformed scope is a 400 on both surfaces", async () => {
  freshHome();
  await withFront(async (port) => {
    for (const path of ["/api/local/secrets", "/api/local/vars"]) {
      const res = await req(port, `${path}?name=OK_NAME&scope=not%20a%20slug`, { method: "DELETE" });
      assert.equal(res.status, 400, `${path} must 400 on a bad scope`);
      assert.match(JSON.parse(res.body).error, /scope/);
    }
  });
});

test("a failing store write/delete surfaces as a 500 with the message (files made read-only)", async () => {
  const { chmod } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const home = freshHome();
  await withFront(async (port) => {
    // Seed one secret and one var so the store files exist, then freeze them.
    assert.equal((await postJson(port, "/api/local/secrets", { name: "FROZEN_S", value: "v" })).status, 200);
    assert.equal((await postJson(port, "/api/local/vars", { name: "FROZEN_V", value: "v" })).status, 200);
    for (const f of ["secrets.json", "secrets-index.json", "vars.json"]) await chmod(join(home, f), 0o400);
    try {
      const postVar = await postJson(port, "/api/local/vars", { name: "MORE_V", value: "v" });
      assert.equal(postVar.status, 500);
      assert.match(JSON.parse(postVar.body).error, /EACCES|permission denied/);

      const delSecret = await req(port, "/api/local/secrets?name=FROZEN_S", { method: "DELETE" });
      assert.equal(delSecret.status, 500);
      const delVar = await req(port, "/api/local/vars?name=FROZEN_V", { method: "DELETE" });
      assert.equal(delVar.status, 500);
    } finally {
      for (const f of ["secrets.json", "secrets-index.json", "vars.json"]) await chmod(join(home, f), 0o600);
    }
  });
});

// ---- gating: same rule as every /api/local surface ----

interface CapRes {
  res: http.ServerResponse;
  rec: { code?: number; body?: string };
}
function capRes(): CapRes {
  const rec: CapRes["rec"] = {};
  const res = {
    set statusCode(_v: number) {},
    writeHead(code: number) {
      rec.code = code;
    },
    end(b?: string) {
      rec.body = b;
    },
  } as never as http.ServerResponse;
  return { res, rec };
}
const synthReq = (addr: string, url: string, method: string, headers: Record<string, string> = {}) =>
  ({ socket: { remoteAddress: addr }, headers, url, method }) as never as http.IncomingMessage;
const noMint = async () => null;

test("gating: non-loopback writes are denied — 403 without basic auth, 401 when it is configured", async () => {
  freshHome();
  for (const path of ["/api/local/secrets", "/api/local/vars"]) {
    for (const method of ["POST", "DELETE"]) {
      const open = capRes();
      await gate.handleRequest(synthReq("10.0.0.4", path, method), open.res, { basicAuth: undefined } as never, noMint);
      assert.equal(open.rec.code, 403, `${method} ${path} must 403 from LAN`);

      const withAuth = capRes();
      await gate.handleRequest(synthReq("10.0.0.4", path, method), withAuth.res, { basicAuth: "ops:pw" } as never, noMint);
      assert.equal(withAuth.rec.code, 401, `${method} ${path} must 401 when basic auth is on`);
    }
  }
});

test("gating: a correctly-authenticated non-loopback DELETE passes the gate and reaches the store", async () => {
  freshHome();
  const auth = { authorization: `Basic ${Buffer.from("ops:pw").toString("base64")}` };
  const c = capRes();
  await gate.handleRequest(
    synthReq("10.0.0.4", "/api/local/vars?name=NOPE&scope=global", "DELETE", auth),
    c.res,
    { basicAuth: "ops:pw" } as never,
    noMint,
  );
  assert.equal(c.rec.code, 200);
  assert.equal(JSON.parse(c.rec.body ?? "").removed, false);
});

// ---- parseScope unit coverage ----

test("parseScope: absent/global → global; owner/name passes; junk is rejected", () => {
  assert.equal(parseScope(undefined), "global");
  assert.equal(parseScope(null), "global");
  assert.equal(parseScope(""), "global");
  assert.equal(parseScope("global"), "global");
  assert.equal(parseScope("acme/api"), "acme/api");
  assert.equal(parseScope("no-slash"), null);
  assert.equal(parseScope("a/b/c"), null);
  assert.equal(parseScope("a b/c"), null);
  assert.equal(parseScope(42), null);
});
