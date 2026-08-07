import { test } from "node:test";
import assert from "node:assert/strict";
import { logsCmd, watchCmd, formatRunLogs, frameLines, pickLatestAttempt, resolveRun } from "../logs.js";

function captureOut(): { logs: string[]; errs: string[]; restore: () => void } {
  const logs: string[] = [];
  const errs: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  return { logs, errs, restore: () => ((console.log = ol), (console.error = oe)) };
}

const sse = (event: string, dataObj: unknown) => `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;

// ── pure helpers ──────────────────────────────────────────────────────────────
test("pickLatestAttempt: highest attempt number, or null", () => {
  assert.equal(pickLatestAttempt([]), null);
  assert.deepEqual(pickLatestAttempt([{ attempt: 1 }, { attempt: 3 }, { attempt: 2 }]), { attempt: 3 });
});

test("frameLines: only 'log' frames for a followed timeline; ANSI stripped; others dropped", () => {
  const tls = new Set(["TL1"]);
  assert.deepEqual(frameLines({ event: "log", data: JSON.stringify({ timelineId: "TL1", record: { value: ["\x1b[32mhello\x1b[0m", "world"] } }) }, tls), ["hello", "world"]);
  assert.deepEqual(frameLines({ event: "log", data: JSON.stringify({ timelineId: "TLX", record: { value: ["nope"] } }) }, tls), []);
  assert.deepEqual(frameLines({ event: "ping", data: "{}" }, tls), []);
  assert.deepEqual(frameLines({ event: "log", data: "not json" }, tls), []);
  assert.deepEqual(frameLines({ event: "log", data: JSON.stringify({ timelineId: "TL1" }) }, tls), []); // no value
});

test("formatRunLogs: single job prints lines; multi-job adds headers; empty/denied/no-jobs noted", () => {
  assert.deepEqual(formatRunLogs(5, [{ name: "build", retained: true, lines: ["a", "b"] }]), ["a", "b"]);
  const multi = formatRunLogs(5, [
    { name: "build", retained: true, lines: ["x"] },
    { name: "test", retained: false, lines: [] },
  ]);
  assert.match(multi.join("\n"), /=== build ===\nx\n=== test ===\n\[ndh\] no retained logs for job 'test'/);
  assert.match(formatRunLogs(5, [{ name: "build", retained: false, lines: [] }]).join("\n"), /no retained logs for run #5/);
  assert.match(formatRunLogs(5, [{ name: "build", retained: false, lines: [], denied: 403 }]).join("\n"), /loopback-gated/);
  assert.match(formatRunLogs(5, []).join("\n"), /run #5 has no jobs/);
});

test("formatRunLogs: a 401-denied job names the basic-auth gate, never 'no retained logs' (#100)", () => {
  const out = formatRunLogs(5, [{ name: "build", retained: false, lines: [], denied: 401 }]).join("\n");
  assert.match(out, /requires basic auth for logs — run on the hub host, tunnel the port, or open the UI with credentials/);
  assert.doesNotMatch(out, /no retained logs/);
});

test("resolveRun: unwraps attempts + jobs, marks completed, drops job entries without a timeline", async () => {
  const routes: Record<string, unknown> = {
    "/_apis/v1/Message/workflow/run/7/attempts": { value: [{ attempt: 1, status: "completed", result: "succeeded" }] },
    "/_apis/v1/Message/workflow/run/7/attempt/1/jobs": [{ timeLineId: "TL1", name: "build" }, { name: "no-tl" }],
  };
  const run = (await resolveRun("http://h/", 7, async (u) => routes[new URL(u).pathname]))!;
  assert.equal(run.completed, true);
  assert.equal(run.result, "succeeded");
  assert.deepEqual(run.jobs, [{ timeLineId: "TL1", name: "build" }]);
});

// ── logsCmd ───────────────────────────────────────────────────────────────────
function jsonRoutes(routes: Record<string, unknown>) {
  return async (u: string) => {
    const p = new URL(u).pathname;
    if (!(p in routes)) throw Object.assign(new Error(`${p}: 500`), { httpStatus: 500 });
    return routes[p];
  };
}

test("logsCmd: prints a completed run's persisted job logs (#66)", async () => {
  const cap = captureOut();
  try {
    const code = await logsCmd(2, "http://127.0.0.1:6099", {
      getJson: jsonRoutes({
        "/_apis/v1/Message/workflow/run/2/attempts": [{ attempt: 1, status: "completed", result: "succeeded" }],
        "/_apis/v1/Message/workflow/run/2/attempt/1/jobs": [{ timeLineId: "TLb", name: "build" }],
      }),
      getJoblogs: async (_b, runId, tl) => {
        assert.equal(runId, 2);
        assert.equal(tl, "TLb");
        return { retained: true, lines: ["Run echo hello", "hello"] };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(cap.logs, ["Run echo hello", "hello"]); // single job → no header
  } finally {
    cap.restore();
  }
});

test("logsCmd: an unknown run id reports no jobs, exit 1", async () => {
  const cap = captureOut();
  try {
    const code = await logsCmd(999, "http://127.0.0.1:6099", {
      getJson: jsonRoutes({ "/_apis/v1/Message/workflow/run/999/attempts": [] }),
    });
    assert.equal(code, 1);
    assert.match(cap.logs.join("\n"), /run #999 has no jobs/);
  } finally {
    cap.restore();
  }
});

test("logsCmd: a loopback-gated (403) joblogs response prints the tunnel hint, exit 1", async () => {
  const cap = captureOut();
  try {
    const code = await logsCmd(2, "http://192.168.1.5:6099", {
      getJson: jsonRoutes({
        "/_apis/v1/Message/workflow/run/2/attempts": [{ attempt: 1, status: "completed" }],
        "/_apis/v1/Message/workflow/run/2/attempt/1/jobs": [{ timeLineId: "TLb", name: "build" }],
      }),
      getJoblogs: async () => ({ retained: false, lines: [], status: 403 }),
    });
    assert.equal(code, 1);
    assert.match(cap.logs.join("\n"), /loopback-gated/);
    assert.doesNotMatch(cap.logs.join("\n"), /no retained logs/);
  } finally {
    cap.restore();
  }
});

test("logsCmd: a basic-auth hub's 401 surfaces the auth gate, not 'no retained logs', exit 1 (#100)", async () => {
  const cap = captureOut();
  try {
    const code = await logsCmd(5, "http://192.168.1.5:6099", {
      getJson: jsonRoutes({
        "/_apis/v1/Message/workflow/run/5/attempts": [{ attempt: 1, status: "completed" }],
        "/_apis/v1/Message/workflow/run/5/attempt/1/jobs": [{ timeLineId: "TLb", name: "build" }],
      }),
      getJoblogs: async () => ({ retained: false, lines: [], status: 401 }),
    });
    assert.equal(code, 1);
    assert.match(cap.logs.join("\n"), /requires basic auth for logs/);
    assert.doesNotMatch(cap.logs.join("\n"), /no retained logs/);
  } finally {
    cap.restore();
  }
});

test("logsCmd: a genuinely empty (200, unretained) run still reads 'no retained logs', exit 0", async () => {
  const cap = captureOut();
  try {
    const code = await logsCmd(6, "http://127.0.0.1:6099", {
      getJson: jsonRoutes({
        "/_apis/v1/Message/workflow/run/6/attempts": [{ attempt: 1, status: "completed" }],
        "/_apis/v1/Message/workflow/run/6/attempt/1/jobs": [{ timeLineId: "TLb", name: "build" }],
      }),
      getJoblogs: async () => ({ retained: false, lines: [] }),
    });
    assert.equal(code, 0);
    assert.match(cap.logs.join("\n"), /no retained logs for run #6/);
  } finally {
    cap.restore();
  }
});

test("logsCmd: an unreachable hub prints the [ndh] line, exit 1 (#69 parity)", async () => {
  const cap = captureOut();
  try {
    const code = await logsCmd(2, "http://127.0.0.1:6099", {
      getJson: async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      },
    });
    assert.equal(code, 1);
    assert.match(cap.errs.join("\n"), /can't reach the hub/);
  } finally {
    cap.restore();
  }
});

// ── watchCmd ──────────────────────────────────────────────────────────────────
test("watchCmd: streams matching console lines live and exits 0 when the run completes (#66)", async () => {
  const cap = captureOut();
  const emitted: string[] = [];
  let attemptsFetches = 0;
  try {
    const code = await watchCmd(3, "http://127.0.0.1:6099", {
      delay: async () => {},
      pollMs: 1,
      emit: (l) => emitted.push(l),
      getJson: async (u) => {
        const p = new URL(u).pathname;
        if (p.endsWith("/attempts")) {
          attemptsFetches++;
          // in_progress on the first resolve, completed on the poll
          return [{ attempt: 1, status: attemptsFetches >= 2 ? "completed" : "in_progress", result: "succeeded" }];
        }
        return [{ timeLineId: "TL1", name: "build" }];
      },
      openConsole: (_base, onChunk) => {
        // Emit one matching frame and one for a different run's timeline.
        onChunk(sse("log", { timelineId: "TL1", record: { value: ["building…", "done"] } }));
        onChunk(sse("log", { timelineId: "TLother", record: { value: ["not mine"] } }));
        return () => {};
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(emitted, ["building…", "done"]); // only this run's timeline
    assert.match(cap.errs.join("\n"), /run #3 completed \(succeeded\)/);
  } finally {
    cap.restore();
  }
});

test("watchCmd: a run that is already completed points at `ndh logs`, exit 0", async () => {
  const cap = captureOut();
  try {
    const code = await watchCmd(2, "http://127.0.0.1:6099", {
      getJson: async (u) =>
        new URL(u).pathname.endsWith("/attempts") ? [{ attempt: 1, status: "completed", result: "succeeded" }] : [{ timeLineId: "TL1" }],
      openConsole: () => () => {},
    });
    assert.equal(code, 0);
    assert.match(cap.errs.join("\n"), /already completed .* use 'ndh logs 2'/);
  } finally {
    cap.restore();
  }
});

test("watchCmd: an unknown run id exits 1", async () => {
  const cap = captureOut();
  try {
    const code = await watchCmd(999, "http://127.0.0.1:6099", { getJson: async () => [], openConsole: () => () => {} });
    assert.equal(code, 1);
    assert.match(cap.errs.join("\n"), /run #999 not found/);
  } finally {
    cap.restore();
  }
});

test("watchCmd: the console stream dropping mid-follow ends the watch with the [ndh] line, exit 1", async () => {
  const cap = captureOut();
  try {
    const code = await watchCmd(3, "http://127.0.0.1:6099", {
      delay: async () => {},
      pollMs: 1,
      getJson: async (u) =>
        new URL(u).pathname.endsWith("/attempts") ? [{ attempt: 1, status: "in_progress" }] : [{ timeLineId: "TL1" }],
      openConsole: (_b, _onChunk, onError) => {
        onError(new TypeError("fetch failed", { cause: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) }));
        return () => {};
      },
    });
    assert.equal(code, 1);
    assert.match(cap.errs.join("\n"), /can't reach the hub/);
  } finally {
    cap.restore();
  }
});

test("watchCmd: a transient (non-connection) poll failure is tolerated, then the run completes", async () => {
  const cap = captureOut();
  let attempts = 0;
  try {
    const code = await watchCmd(3, "http://127.0.0.1:6099", {
      delay: async () => {},
      pollMs: 1,
      emit: () => {},
      getJson: async (u) => {
        if (new URL(u).pathname.endsWith("/attempts")) {
          attempts++;
          if (attempts === 1) return [{ attempt: 1, status: "in_progress" }]; // initial resolve
          if (attempts === 2) throw new Error("/attempts: 500"); // transient poll failure (non-conn) → tolerated
          return [{ attempt: 1, status: "completed", result: "succeeded" }]; // then completes
        }
        return [{ timeLineId: "TL1" }];
      },
      openConsole: () => () => {},
    });
    assert.equal(code, 0);
    assert.match(cap.errs.join("\n"), /run #3 completed/);
  } finally {
    cap.restore();
  }
});

test("watchCmd: an unreachable hub prints the [ndh] line, exit 1", async () => {
  const cap = captureOut();
  try {
    const code = await watchCmd(3, "http://127.0.0.1:6099", {
      getJson: async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      },
      openConsole: () => () => {},
    });
    assert.equal(code, 1);
    assert.match(cap.errs.join("\n"), /can't reach the hub/);
  } finally {
    cap.restore();
  }
});
