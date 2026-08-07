import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, runCancelCmd, runDeleteCmd } from "../run-actions.js";

interface Call {
  url: string;
  method: string;
}

/** Build a fetch seam that records calls and answers from a URL+method router. */
function fakeFetch(
  router: (url: string, method: string) => { status?: number; body?: unknown; throw?: boolean },
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const r = router(url, method);
    if (r.throw) throw new Error("network down");
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// ── parseArgs ─────────────────────────────────────────────────────────────────
test("parseArgs: defaults, --server (both forms), --project (both forms), positionals", () => {
  assert.deepEqual(parseArgs([]), { positionals: [], server: "http://localhost:4949", project: undefined });
  assert.equal(parseArgs(["--server", "http://h:1"]).server, "http://h:1");
  assert.equal(parseArgs(["--server=http://h:2"]).server, "http://h:2");
  assert.equal(parseArgs(["--project", "a/b"]).project, "a/b");
  assert.equal(parseArgs(["--project=c/d"]).project, "c/d");
  assert.deepEqual(parseArgs(["42", "--server", "http://h:3"]).positionals, ["42"]);
});

// ── run cancel ──────────────────────────────────────────────────────────────
test("runCancelCmd: usage error (exit 2) with no id or a non-numeric id", async () => {
  assert.equal(await runCancelCmd([], { fetchImpl: fakeFetch(() => ({})).impl }), 2);
  assert.equal(await runCancelCmd(["abc"], { fetchImpl: fakeFetch(() => ({})).impl }), 2);
});

test("runCancelCmd: posts to the cancel endpoint and exits 0", async () => {
  const f = fakeFetch(() => ({ status: 200 }));
  assert.equal(await runCancelCmd(["42", "--server", "http://h:9"], { fetchImpl: f.impl }), 0);
  assert.deepEqual(f.calls, [{ url: "http://h:9/api/local/runs/42/cancel", method: "POST" }]);
});

test("runCancelCmd: exit 1 on a non-OK response", async () => {
  const f = fakeFetch(() => ({ status: 404 }));
  assert.equal(await runCancelCmd(["5"], { fetchImpl: f.impl }), 1);
});

test("runCancelCmd: exit 1 when the hub is unreachable", async () => {
  const f = fakeFetch(() => ({ throw: true }));
  assert.equal(await runCancelCmd(["5"], { fetchImpl: f.impl }), 1);
});

// ── run delete (single) ──────────────────────────────────────────────────────
test("runDeleteCmd: usage error (exit 2) with no id and no --project", async () => {
  assert.equal(await runDeleteCmd([], { fetchImpl: fakeFetch(() => ({})).impl }), 2);
});

test("runDeleteCmd: deletes one run and exits 0", async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: true, logsPurged: 4 } }));
  assert.equal(await runDeleteCmd(["42", "--server", "http://h:9"], { fetchImpl: f.impl }), 0);
  assert.deepEqual(f.calls, [{ url: "http://h:9/api/local/runs/42", method: "DELETE" }]);
});

test("runDeleteCmd: exit 1 on a non-OK single delete", async () => {
  const f = fakeFetch(() => ({ status: 500 }));
  assert.equal(await runDeleteCmd(["42"], { fetchImpl: f.impl }), 1);
});

// ── run delete --project (bulk, via the front's single contract) ──────────────
test("runDeleteCmd --project: calls DELETE /api/local/runs?project= and exits 0", async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: true, deleted: 2, failed: 0 } }));
  assert.equal(await runDeleteCmd(["--project", "acme/widget", "--server", "http://h:1"], { fetchImpl: f.impl }), 0);
  assert.deepEqual(f.calls, [{ url: "http://h:1/api/local/runs?project=acme%2Fwidget", method: "DELETE" }]);
});

test("runDeleteCmd --project: exit 0 when the endpoint reports zero deleted", async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: true, deleted: 0, failed: 0 } }));
  assert.equal(await runDeleteCmd(["--project", "nobody/here"], { fetchImpl: f.impl }), 0);
});

test("runDeleteCmd --project: exit 1 on a non-OK, non-207 response", async () => {
  const f = fakeFetch(() => ({ status: 502 }));
  assert.equal(await runDeleteCmd(["--project", "acme/widget"], { fetchImpl: f.impl }), 1);
});

test("runDeleteCmd --project: exit 1 (partial) when the endpoint reports failures (207)", async () => {
  const f = fakeFetch(() => ({ status: 207, body: { ok: false, deleted: 1, failed: 1 } }));
  assert.equal(await runDeleteCmd(["--project", "acme/widget"], { fetchImpl: f.impl }), 1);
});

test("runDeleteCmd --project: exit 1 when the hub is unreachable", async () => {
  const f = fakeFetch(() => ({ throw: true }));
  assert.equal(await runDeleteCmd(["--project", "acme/widget"], { fetchImpl: f.impl }), 1);
});
