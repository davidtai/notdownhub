import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFront } from "../front.js";
import { appendDefaultPlatform, serveRerun, workflowUsesCheckout, TREE_GONE } from "../rerunmap.js";
import { treeCacheDir, treeKey } from "../treecache.js";
import { HOSTED_LABELS, hostedToSelfHosted } from "../platform.js";
import { startServer, body, freshHome, type Fixture } from "./helpers.js";

// #92 hub-side platform mapping: the engine has no server-side default mapping config (verified
// against runner.server v3.14.0 and main), so the front supplies it — on proxied schedule2
// dispatches missing `platform`, and by replaying re-runs through schedule2?runid=<id>.

const PLATFORM_DEFAULTS = hostedToSelfHosted();

interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A fake engine: run 5 with one attempt that carries everything a replay needs. */
function fakeHub(capture: Captured[], overrides: Record<string, http.RequestListener> = {}): Promise<Fixture> {
  return startServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const custom = overrides[path];
    if (custom) {
      custom(req, res);
      return;
    }
    if (req.method === "GET" && path === "/_apis/v1/Message/workflow/run/5/attempts") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          { attempt: 1, eventName: "push", eventPayload: JSON.stringify({ repository: { full_name: "acme/widget" } }), workflow: "on: push\njobs: {}\n", ref: "refs/heads/main", sha: "abc123" },
        ]),
      );
      return;
    }
    if (req.method === "GET" && path === "/_apis/v1/Message/workflow/run/5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 5, fileName: ".github/workflows/ci.yml" }));
      return;
    }
    capture.push({ url: req.url ?? "", headers: req.headers, body: (await body(req)).toString("utf8") });
    if (req.method === "POST" && path === "/_apis/v1/Message/schedule2") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: workflow\ndata: {}\n\n");
      return;
    }
    res.writeHead(200);
    res.end();
  });
}

async function front(hubPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = startFront({ port: 0, hubPort, uiDir: null });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

// NOTE (#105, determinism): no waiting is needed anywhere in this file. On every path these
// tests exercise, the fake hub pushes to `seen` BEFORE it sends its response, and the front
// only answers the client after that response: serveRerun awaits the schedule2 POST before its
// 200, and the plain proxy pipes the hub's response through. So by the time `post()` resolves,
// the capture is already in `seen` — the awaited response IS the synchronization. The old
// `until()` poll here (10ms setTimeout loop, silent 2s expiry — written for a fire-and-forget
// draft of serveRerun that no longer exists) provided no ordering; what it did do was convert
// any transient upstream failure (proxy()'s 502 "hub unavailable" backstop, seen only under a
// loaded full-suite run) into a 2-second stall followed by a TypeError on `seen[0]`, because
// the response status was never checked. Hence: no timers, `agent: false` so no test can reuse
// a pooled keep-alive socket to a recycled port, and every test asserts status + capture count
// so a one-off infra failure is reported instantly at the right line.
function post(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method: "POST", agent: false }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("platform defaults: every hosted label maps to -self-hosted, self-hosted itself is absent", () => {
  assert.deepEqual(PLATFORM_DEFAULTS, HOSTED_LABELS.map((l) => `${l}=-self-hosted`));
  assert.ok(!PLATFORM_DEFAULTS.some((p) => p.startsWith("self-hosted=")));
});

test("appendDefaultPlatform: adds the mapping only when the dispatch carries none", () => {
  const rewritten = appendDefaultPlatform("/_apis/v1/Message/schedule2?Repository=a%2Fb");
  const u = new URL(rewritten, "http://x");
  assert.deepEqual(u.searchParams.getAll("platform"), PLATFORM_DEFAULTS);
  assert.equal(u.searchParams.get("Repository"), "a/b");
  // An explicit mapping passes through byte-identical — the dispatcher's -P wins.
  const explicit = "/_apis/v1/Message/schedule2?platform=ubuntu-latest%3Ddocker.io%2Fx";
  assert.equal(appendDefaultPlatform(explicit), explicit);
});

test("rerunworkflow is replayed via schedule2?runid with the default mapping and the stored attempt", async () => {
  const seen: Captured[] = [];
  const hub = await fakeHub(seen);
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/rerunworkflow/5");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, runId: 5, attempt: 2 });

    // serveRerun awaited the schedule2 POST before answering, so the replay is captured.
    assert.equal(seen.length, 1);
    const [replay] = seen;
    const u = new URL(replay.url, "http://x");
    assert.equal(u.pathname, "/_apis/v1/Message/schedule2");
    assert.equal(u.searchParams.get("runid"), "5");
    assert.equal(u.searchParams.get("localcheckout"), "false");
    assert.equal(u.searchParams.get("resetArtifacts"), "true");
    assert.equal(u.searchParams.get("failed"), null);
    assert.equal(u.searchParams.get("Ref"), "refs/heads/main");
    assert.equal(u.searchParams.get("Sha"), "abc123");
    assert.equal(u.searchParams.get("Repository"), "acme/widget");
    assert.deepEqual(u.searchParams.getAll("platform"), PLATFORM_DEFAULTS);
    assert.equal(replay.headers["x-github-event"], "push");
    // Multipart carries the stored event payload and the workflow YAML under the run's file name.
    assert.match(replay.body, /name="event"; filename="event.json"/);
    assert.match(replay.body, /"full_name":"acme\/widget"/);
    assert.match(replay.body, /filename="\.github\/workflows\/ci\.yml"/);
    assert.match(replay.body, /on: push/);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("rerunFailed replays with failed=true and does not reset artifacts (native semantics)", async () => {
  const seen: Captured[] = [];
  const hub = await fakeHub(seen);
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/rerunFailed/5");
    assert.equal(res.status, 200, res.body);
    assert.equal(seen.length, 1);
    const u = new URL(seen[0].url, "http://x");
    assert.equal(u.searchParams.get("failed"), "true");
    assert.equal(u.searchParams.get("resetArtifacts"), "false");
  } finally {
    await f.close();
    await hub.close();
  }
});

test("onLatestCommit=true is not replayed — the native endpoint serves it", async () => {
  const seen: Captured[] = [];
  const hub = await fakeHub(seen);
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/rerunworkflow/5?onLatestCommit=true");
    assert.equal(res.status, 200, res.body);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /rerunworkflow\/5\?onLatestCommit=true/);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("unreadable attempts fall back to the native re-run proxy (pre-#92 behavior)", async () => {
  const seen: Captured[] = [];
  const hub = await fakeHub(seen, {
    "/_apis/v1/Message/workflow/run/5/attempts": (_req, res) => {
      res.writeHead(500);
      res.end();
    },
  });
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/rerunworkflow/5");
    assert.equal(res.status, 200, res.body);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /rerunworkflow\/5$/);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("an attempt with no stored workflow YAML falls back to the native re-run proxy", async () => {
  const seen: Captured[] = [];
  const hub = await fakeHub(seen, {
    "/_apis/v1/Message/workflow/run/5/attempts": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ attempt: 1, workflow: null }]));
    },
  });
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/rerunworkflow/5");
    assert.equal(res.status, 200, res.body);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /rerunworkflow\/5$/);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("a failing schedule2 upstream is reported as 502, not swallowed", async () => {
  const seen: Captured[] = [];
  const hub = await fakeHub(seen, {
    "/_apis/v1/Message/schedule2": (_req, res) => {
      res.writeHead(500);
      res.end();
    },
  });
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/rerunworkflow/5");
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).ok, false);
  } finally {
    await f.close();
    await hub.close();
  }
});

test("dispatch: a proxied schedule2 without platform gets the default mapping appended", async () => {
  const seen: Captured[] = [];
  const hub = await fakeHub(seen);
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/schedule2?Repository=acme%2Fwidget");
    assert.equal(res.status, 200, res.body);
    assert.equal(seen.length, 1);
    const u = new URL(seen[0].url, "http://x");
    assert.deepEqual(u.searchParams.getAll("platform"), PLATFORM_DEFAULTS);
    assert.equal(u.searchParams.get("Repository"), "acme/widget");
  } finally {
    await f.close();
    await hub.close();
  }
});

test("dispatch: an explicit -P mapping passes through the proxy untouched", async () => {
  const seen: Captured[] = [];
  const hub = await fakeHub(seen);
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/schedule2?platform=ubuntu-latest%3Dcatthehacker%2Fubuntu%3Aact-latest");
    assert.equal(res.status, 200, res.body);
    assert.equal(seen.length, 1);
    const u = new URL(seen[0].url, "http://x");
    assert.deepEqual(u.searchParams.getAll("platform"), ["ubuntu-latest=catthehacker/ubuntu:act-latest"]);
  } finally {
    await f.close();
    await hub.close();
  }
});

/** Minimal ServerResponse stand-in for driving serveRerun directly. */
function fakeRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0;
  let out = "";
  const res = {
    writeHead: (s: number) => {
      status = s;
    },
    end: (b?: string) => {
      out = b ?? "";
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => out };
}

test("serveRerun: a thrown schedule2 fetch (engine gone mid-replay) answers 502", async () => {
  const attempts = [{ attempt: 3, eventName: "", eventPayload: "not json", workflow: "on: push\n" }];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("boom");
    const s = String(input);
    if (s.endsWith("/attempts")) return Response.json(attempts);
    return Response.json({ fileName: null });
  }) as typeof fetch;
  const { res, status, body: bodyOf } = fakeRes();
  assert.equal(await serveRerun(1, 9, false, res, { fetch: doFetch }), true);
  assert.equal(status(), 502);
  assert.equal(JSON.parse(bodyOf()).ok, false);
});

// ── #110: the replay carries the localcheckout wiring the original dispatch used ────────────

const CHECKOUT_WF = "on: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n    - uses: actions/checkout@v4\n";

/** Plant a complete retained tree for a run in the current NDH_HOME. */
function plantTree(runId: number): void {
  const dir = join(treeCacheDir(), String(runId));
  mkdirSync(dir, { recursive: true });
  const key = treeKey(new URLSearchParams());
  writeFileSync(join(dir, `${key}.multipart`), "tree-bytes");
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({ contentType: "multipart/form-data; boundary=x" }));
}

test("workflowUsesCheckout: uses-lines at any ref, quoted or not; lookalikes do not count", () => {
  assert.equal(workflowUsesCheckout(CHECKOUT_WF), true);
  assert.equal(workflowUsesCheckout('steps:\n  - uses: "actions/checkout@11bd719"\n'), true);
  assert.equal(workflowUsesCheckout("- uses: actions/checkout@v4.1.2\n"), true);
  assert.equal(workflowUsesCheckout("uses: actions/checkout@v2"), true);
  assert.equal(workflowUsesCheckout("on: push\njobs: {}\n"), false);
  assert.equal(workflowUsesCheckout("- uses: my/actions/checkout@v4\n"), false);
  assert.equal(workflowUsesCheckout("# excuses: actions/checkout@v4\n"), false);
});

test("a retained tree flips the replay to localcheckout=true (full and failed-only)", async () => {
  freshHome();
  plantTree(5);
  const seen: Captured[] = [];
  const hub = await fakeHub(seen);
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/rerunworkflow/5");
    assert.equal(res.status, 200, res.body);
    const failedRes = await post(f.port, "/_apis/v1/Message/rerunFailed/5");
    assert.equal(failedRes.status, 200, failedRes.body);
    assert.equal(seen.length, 2);
    for (const replay of seen) {
      const u = new URL(replay.url, "http://x");
      assert.equal(u.pathname, "/_apis/v1/Message/schedule2");
      assert.equal(u.searchParams.get("localcheckout"), "true");
      assert.deepEqual(u.searchParams.getAll("platform"), PLATFORM_DEFAULTS);
    }
  } finally {
    await f.close();
    await hub.close();
  }
});

test("no tree + a checkout workflow + no hub token → honest 409, nothing queued", async () => {
  freshHome(); // no retained tree in this home
  const seen: Captured[] = [];
  const hub = await fakeHub(seen, {
    "/_apis/v1/Message/workflow/run/5/attempts": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ attempt: 2, eventName: "push", eventPayload: "{}", workflow: CHECKOUT_WF }]));
    },
  });
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/rerunworkflow/5");
    assert.equal(res.status, 409);
    const bodyJson = JSON.parse(res.body);
    assert.equal(bodyJson.ok, false);
    assert.equal(bodyJson.error, TREE_GONE);
    assert.equal(bodyJson.runId, 5);
    assert.equal(seen.length, 0); // neither schedule2 nor the native endpoint was touched
  } finally {
    await f.close();
    await hub.close();
  }
});

test("no tree + checkout workflow, but the hub HAS a github token → replay with localcheckout=false", async () => {
  freshHome();
  const attempts = [{ attempt: 1, eventName: "push", eventPayload: "{}", workflow: CHECKOUT_WF }];
  let target: URL | null = null;
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const s = String(input);
    if (init?.method === "POST") {
      target = new URL(s);
      return new Response("", { status: 200 });
    }
    if (s.endsWith("/attempts")) return Response.json(attempts);
    return Response.json({ fileName: "ci.yml" });
  }) as typeof fetch;
  const { res, status } = fakeRes();
  assert.equal(await serveRerun(1, 9, false, res, { fetch: doFetch, githubToken: "ghp_x" }), true);
  assert.equal(status(), 200);
  assert.equal(target!.searchParams.get("localcheckout"), "false");
});

test("no tree + a workflow WITHOUT checkout replays exactly as before (localcheckout=false)", async () => {
  freshHome();
  const seen: Captured[] = [];
  const hub = await fakeHub(seen); // fakeHub's stored workflow has no checkout step
  const f = await front(hub.port);
  try {
    const res = await post(f.port, "/_apis/v1/Message/rerunworkflow/5");
    assert.equal(res.status, 200, res.body);
    assert.equal(seen.length, 1);
    const u = new URL(seen[0].url, "http://x");
    assert.equal(u.searchParams.get("localcheckout"), "false");
  } finally {
    await f.close();
    await hub.close();
  }
});

test("serveRerun: the hasTree seam wires localcheckout=true without touching the filesystem", async () => {
  const attempts = [{ attempt: 4, eventName: "push", eventPayload: "{}", workflow: CHECKOUT_WF }];
  let target: URL | null = null;
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const s = String(input);
    if (init?.method === "POST") {
      target = new URL(s);
      return new Response("", { status: 200 });
    }
    if (s.endsWith("/attempts")) return Response.json(attempts);
    return Response.json({ fileName: "ci.yml" });
  }) as typeof fetch;
  const { res, status, body: bodyOf } = fakeRes();
  assert.equal(await serveRerun(1, 14, false, res, { fetch: doFetch, hasTree: async () => true }), true);
  assert.equal(status(), 200);
  assert.equal(JSON.parse(bodyOf()).attempt, 5);
  assert.equal(target!.searchParams.get("localcheckout"), "true");
});

test("serveRerun: non-JSON payload and missing fileName use safe fallbacks", async () => {
  let target: URL | null = null;
  let form: FormData | null = null;
  const attempts = [{ attempt: 1, eventPayload: "not json", workflow: "on: push\n" }, { attempt: 2, eventPayload: "not json", workflow: "on: push\n" }];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const s = String(input);
    if (init?.method === "POST") {
      target = new URL(s);
      form = init.body as FormData;
      return new Response("", { status: 200 });
    }
    if (s.endsWith("/attempts")) return Response.json(attempts);
    return new Response("", { status: 500 }); // single-run read fails → fileName fallback
  }) as typeof fetch;
  const { res, status, body: bodyOf } = fakeRes();
  assert.equal(await serveRerun(1, 9, false, res, { fetch: doFetch }), true);
  assert.equal(status(), 200);
  // Latest attempt (2) wins; the reply names the attempt the engine will create next.
  assert.equal(JSON.parse(bodyOf()).attempt, 3);
  assert.equal(target!.searchParams.get("Repository"), null);
  assert.equal(target!.searchParams.get("Ref"), null);
  assert.equal((form!.get("workflow") as File).name, "workflow.yml");
  // The event header falls back to push when the attempt stored no event name.
  assert.equal(target!.searchParams.get("runid"), "9");
});
