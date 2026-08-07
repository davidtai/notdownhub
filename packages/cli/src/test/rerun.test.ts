import { test } from "node:test";
import assert from "node:assert/strict";
import { rerunCmd, parseRerunArgs, __test } from "../rerun.js";

/** A fetch stub that records calls and replies from a scripted queue of responses. */
function stubFetch(responses: Array<{ ok?: boolean; status?: number; statusText?: string; json?: unknown } | Error>) {
  const calls: { url: string; method: string }[] = [];
  let i = 0;
  const fn = (async (input: URL | string, init?: { method?: string }) => {
    calls.push({ url: input.toString(), method: init?.method ?? "GET" });
    const r = responses[i++] ?? { ok: true, status: 200, json: {} };
    if (r instanceof Error) throw r;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.statusText ?? "OK",
      json: async () => r.json ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function capture() {
  const out: string[] = [];
  const errs: string[] = [];
  return { out, errs, log: (m: string) => out.push(m), error: (m: string) => errs.push(m) };
}

test("parseRerunArgs: id, --server (both forms), --failed, --help", () => {
  assert.deepEqual(parseRerunArgs(["2", "--server", "http://h:4949"]), {
    id: "2",
    server: "http://h:4949",
    failed: false,
    help: false,
  });
  assert.deepEqual(parseRerunArgs(["--server=http://h", "3", "--failed"]), {
    id: "3",
    server: "http://h",
    failed: true,
    help: false,
  });
  assert.equal(parseRerunArgs(["-h"]).help, true);
  assert.equal(parseRerunArgs(["--help"]).help, true);
  // first positional wins; later positionals ignored
  assert.equal(parseRerunArgs(["5", "9"]).id, "5");
});

test("projectLabel: owner/repo, one half, or local", () => {
  assert.equal(__test.projectLabel({ owner: "acme", repo: "widget" }), "acme/widget");
  assert.equal(__test.projectLabel({ repo: "widget" }), "widget");
  assert.equal(__test.projectLabel({ owner: "acme" }), "acme");
  assert.equal(__test.projectLabel({}), "local");
});

test("--help prints usage, exits 0, makes no request", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => logs.push(String(m));
  try {
    const { fn, calls } = stubFetch([]);
    assert.equal(await rerunCmd(["--help"], { fetch: fn }), 0);
    assert.equal(calls.length, 0);
    assert.match(logs.join("\n"), /usage: ndh run rerun/);
  } finally {
    console.log = orig;
  }
});

test("missing --server exits 2", async () => {
  const c = capture();
  const { fn, calls } = stubFetch([]);
  assert.equal(await rerunCmd(["2"], { fetch: fn, log: c.log, error: c.error }), 2);
  assert.equal(calls.length, 0);
  assert.match(c.errs.join(" "), /missing --server/);
});

test("missing <run-id> exits 2", async () => {
  const c = capture();
  const { fn, calls } = stubFetch([]);
  assert.equal(await rerunCmd(["--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 2);
  assert.equal(calls.length, 0);
  assert.match(c.errs.join(" "), /missing <run-id>/);
});

test("non-integer / non-positive id exits 2", async () => {
  const c = capture();
  const { fn } = stubFetch([]);
  assert.equal(await rerunCmd(["abc", "--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 2);
  assert.equal(await rerunCmd(["0", "--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 2);
  assert.equal(await rerunCmd(["-1", "--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 2);
  assert.match(c.errs.join(" "), /invalid run id/);
});

test("happy path: reads the runs list for the label, POSTs rerunworkflow, exits 0", async () => {
  const c = capture();
  const { fn, calls } = stubFetch([
    { ok: true, json: [{ id: 2, displayName: "ci", owner: "acme", repo: "widget" }] },
    { ok: true, status: 200 },
  ]);
  assert.equal(await rerunCmd(["2", "--server", "http://h:4949"], { fetch: fn, log: c.log, error: c.error }), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /_apis\/v1\/Message\/workflow\/runs\?page=0$/);
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].url, /_apis\/v1\/Message\/rerunworkflow\/2$/);
  assert.match(c.out.join("\n"), /re-run queued for #2 \(acme\/widget · ci\)/);
});

test("labels from a later page + OData envelope; pages until the run is found", async () => {
  const c = capture();
  const { fn, calls } = stubFetch([
    { ok: true, json: { value: [{ id: 9, displayName: "other" }] } }, // page 0 — no #2
    { ok: true, json: [{ id: 2, displayName: "ci", owner: "acme", repo: "widget" }] }, // page 1
    { ok: true }, // POST
  ]);
  assert.equal(await rerunCmd(["2", "--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 0);
  assert.match(calls[0].url, /page=0$/);
  assert.match(calls[1].url, /page=1$/);
  assert.match(calls[2].url, /rerunworkflow\/2$/);
  assert.match(c.out.join("\n"), /\(acme\/widget · ci\)/);
});

test("--failed targets the rerunFailed endpoint and says so", async () => {
  const c = capture();
  const { fn, calls } = stubFetch([
    { ok: true, json: [{ id: 2, fileName: ".github/workflows/ci.yml" }] },
    { ok: true },
  ]);
  assert.equal(
    await rerunCmd(["2", "--server", "http://h", "--failed"], { fetch: fn, log: c.log, error: c.error }),
    0,
  );
  assert.match(calls[1].url, /_apis\/v1\/Message\/rerunFailed\/2$/);
  assert.match(c.out.join("\n"), /failed jobs only/);
});

test("server without trailing slash is normalized (no double slash)", async () => {
  const c = capture();
  const { fn, calls } = stubFetch([{ ok: true, json: [{ id: 7 }] }, { ok: true }]);
  await rerunCmd(["7", "--server", "http://h:4949"], { fetch: fn, log: c.log, error: c.error });
  assert.match(calls[1].url, /^http:\/\/h:4949\/_apis/);
  assert.doesNotMatch(calls[1].url, /\/\/_apis/);
});

test("a definitively-absent run is refused (exit 1) and never POSTs", async () => {
  const c = capture();
  const { fn, calls } = stubFetch([{ ok: true, json: [] }]); // empty list → scanned to the end
  assert.equal(await rerunCmd(["99", "--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 1);
  assert.equal(calls.length, 1); // no POST
  assert.match(c.errs.join(" "), /no run #99 on http:\/\/h/);
});

test("an unreadable runs list is non-fatal — POST still runs, label omitted", async () => {
  const c = capture();
  const { fn, calls } = stubFetch([new Error("boom"), { ok: true }]);
  assert.equal(await rerunCmd(["2", "--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 0);
  assert.equal(calls.length, 2);
  assert.match(c.out.join("\n"), /re-run queued for #2\b/);
  assert.doesNotMatch(c.out.join("\n"), /·/);
});

test("a non-OK runs list is treated as unknown — no label, POST proceeds", async () => {
  const c = capture();
  const { fn } = stubFetch([{ ok: false, status: 500 }, { ok: true }]);
  assert.equal(await rerunCmd(["2", "--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 0);
  assert.doesNotMatch(c.out.join("\n"), /·/);
});

test("POST 404 (run present) → exit 1 with a 'no such run' hint", async () => {
  const c = capture();
  const { fn } = stubFetch([{ ok: true, json: [{ id: 99 }] }, { ok: false, status: 404, statusText: "Not Found" }]);
  assert.equal(await rerunCmd(["99", "--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 1);
  assert.match(c.errs.join(" "), /re-run failed: hub returned 404 Not Found for #99 — no run #99/);
});

test("a hub refusal (#110) prints the honest reason verbatim", async () => {
  const c = capture();
  const reason = "this run's source tree is not on the hub — re-dispatch it from the checkout with 'ndh dispatch'";
  const { fn } = stubFetch([
    { ok: true, json: [{ id: 14 }] },
    { ok: false, status: 409, statusText: "Conflict", json: { ok: false, error: reason, runId: 14 } },
  ]);
  assert.equal(await rerunCmd(["14", "--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 1);
  assert.match(c.errs.join(" "), /re-run refused for #14: this run's source tree is not on the hub/);
});

test("POST non-404 error → exit 1 without the run hint", async () => {
  const c = capture();
  const { fn } = stubFetch([{ ok: true, json: [{ id: 2 }] }, { ok: false, status: 500, statusText: "Server Error" }]);
  assert.equal(await rerunCmd(["2", "--server", "http://h"], { fetch: fn, log: c.log, error: c.error }), 1);
  assert.match(c.errs.join(" "), /hub returned 500 Server Error for #2$/);
});

test("POST network error → exit 1 with a reachability message", async () => {
  const c = capture();
  const { fn } = stubFetch([{ ok: true, json: [{ id: 2 }] }, new Error("ECONNREFUSED")]);
  assert.equal(await rerunCmd(["2", "--server", "http://h:4949"], { fetch: fn, log: c.log, error: c.error }), 1);
  assert.match(c.errs.join(" "), /could not reach hub at http:\/\/h:4949: ECONNREFUSED/);
});

test("default deps: real log/error paths are exercised (no throw)", async () => {
  // Drive the command with only a fetch stub so the default `say`/`err` sinks run.
  const { fn } = stubFetch([{ ok: true, json: [{ id: 2 }] }, { ok: true }]);
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(await rerunCmd(["2", "--server", "http://h"], { fetch: fn }), 0);
    // and an error path through the default `err`
    const { fn: fn2 } = stubFetch([{ ok: true, json: [{ id: 2 }] }, { ok: false, status: 500 }]);
    assert.equal(await rerunCmd(["2", "--server", "http://h"], { fetch: fn2 }), 1);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});
