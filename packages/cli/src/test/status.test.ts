import { test } from "node:test";
import assert from "node:assert/strict";
import { statusCmd, projectLabel, fmtDuration, fmtTime, runDisplayName, isSkippedRun } from "../status.js";
import type { Fleet } from "../fleet.js";
import type { AgentInfo, RunMeta } from "../agents-info.js";
import { startServer } from "./helpers.js";

function capture(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  return { logs, restore: () => (console.log = orig) };
}

/** A fake hub serving only the runs list (the runner fleet is injected via the `fleet` seam). */
async function runsServing(runs: unknown) {
  return startServer((req, res) => {
    if ((req.url ?? "").startsWith("/_apis/v1/Message/workflow/runs")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(runs));
      return;
    }
    res.writeHead(500);
    res.end("no route");
  });
}

const agent = (name: string, labels: string[], state: AgentInfo["state"]): AgentInfo => ({
  name,
  labels,
  online: state !== "offline",
  busy: state === "active",
  state,
  ephemeral: false,
});
const richFleet = (agents: AgentInfo[]): ((s: string) => Promise<Fleet>) => async () => ({ rich: true, agents });
const namesFleet = (agents: AgentInfo[]): ((s: string) => Promise<Fleet>) => async () => ({ rich: false, agents });
const noMeta = async () => new Map<number, RunMeta>();

test("projectLabel: joins owner/repo, tolerates a missing half, and falls back to local", () => {
  assert.equal(projectLabel({ owner: "acme", repo: "widget" }), "acme/widget");
  assert.equal(projectLabel({ repo: "widget" }), "widget");
  assert.equal(projectLabel({ owner: "acme" }), "acme");
  assert.equal(projectLabel({}), "local");
});

test("fmtDuration: ms / seconds / minutes", () => {
  assert.equal(fmtDuration(820), "820ms");
  assert.equal(fmtDuration(3200), "3.2s");
  assert.equal(fmtDuration(64000), "1m04s");
});

test("fmtTime: trims the hub timestamp to whole seconds with a UTC marker", () => {
  assert.equal(fmtTime("2026-08-07 06:42:34.833163"), "2026-08-07 06:42:34Z");
  assert.equal(fmtTime("garbage"), "garbage");
});

test("runDisplayName: skipped runs get basename + (skipped); executed runs are unchanged (#140)", () => {
  // Filter-skipped: displayName absent or still the raw workflow path → honest basename fallback.
  assert.equal(runDisplayName({ id: 7, fileName: ".github/workflows/ci.yml", result: "skipped" }), "ci.yml (skipped)");
  assert.equal(
    runDisplayName({ id: 7, fileName: ".github/workflows/ci.yml", displayName: ".github/workflows/ci.yml", result: "skipped" }),
    "ci.yml (skipped)",
  );
  // A skipped run that somehow carries a real engine name keeps it.
  assert.equal(runDisplayName({ id: 7, fileName: ".github/workflows/ci.yml", displayName: "app-ci", result: "skipped" }), "app-ci");
  // No file at all → run id, still marked skipped.
  assert.equal(runDisplayName({ id: 7, result: "skipped" }), "run-7 (skipped)");
  // Executed runs: exactly the old displayName ?? fileName ?? "?" behavior.
  assert.equal(runDisplayName({ id: 6, fileName: ".github/workflows/ci.yml", displayName: "app-ci", result: "succeeded" }), "app-ci");
  assert.equal(runDisplayName({ id: 6, fileName: "release.yml" }), "release.yml");
  assert.equal(runDisplayName({ id: 6 }), "?");
  assert.equal(isSkippedRun({ result: "skipped" }), true);
  assert.equal(isSkippedRun({ result: "succeeded" }), false);
  assert.equal(isSkippedRun({}), false);
});

test("statusCmd: rich fleet shows labels + online/busy/idle/offline state (#68)", async () => {
  const srv = await runsServing([]);
  const cap = capture();
  try {
    const code = await statusCmd(srv.url, {
      fleet: richFleet([
        agent("runner-a", ["self-hosted", "macOS", "ARM64", "gpu"], "idle"),
        agent("runner-b", ["self-hosted", "linux", "X64", "cpu"], "offline"),
        agent("runner-c", ["self-hosted"], "active"),
      ]),
      runMeta: noMeta,
    });
    assert.equal(code, 0);
    const out = cap.logs.join("\n");
    assert.match(out, /runner-a {2}\[self-hosted,macOS,ARM64,gpu\] {2}online, idle/);
    assert.match(out, /runner-b {2}\[self-hosted,linux,X64,cpu\] {2}offline/);
    assert.match(out, /runner-c {2}\[self-hosted\] {2}online, busy/);
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("statusCmd: names-only fallback (remote hub) shows labels but no live state", async () => {
  const srv = await runsServing([]);
  const cap = capture();
  try {
    await statusCmd(srv.url, { fleet: namesFleet([agent("r1", ["self-hosted", "macOS"], "offline")]), runMeta: noMeta });
    const out = cap.logs.join("\n");
    assert.match(out, /r1 {2}\[self-hosted,macOS\]/);
    assert.doesNotMatch(out, /online|offline/); // no state column in the fallback
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("statusCmd: no runners → (none registered)", async () => {
  const srv = await runsServing([]);
  const cap = capture();
  try {
    await statusCmd(srv.url, { fleet: richFleet([]), runMeta: noMeta });
    assert.match(cap.logs.join("\n"), /runners:\n {2}\(none registered\)/);
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("statusCmd: recent runs carry project + timestamp/duration/runner when the run executed (#68)", async () => {
  const srv = await runsServing([
    { id: 7, displayName: "CI", status: "completed", result: "success", eventName: "push", owner: "acme", repo: "widget" },
    { id: 8, fileName: "release.yml", status: "in_progress" },
    { id: 9 }, // never ran on the fleet → no meta, plain line
  ]);
  const meta = new Map<number, RunMeta>([
    [7, { startedAt: "2026-08-07 06:42:34.833163", finishedAt: "2026-08-07 06:42:38.933163", durationMs: 4100, runners: ["runner-a"] }],
    [8, { runners: ["runner-b"] }], // running: a runner but no finish yet
  ]);
  const cap = capture();
  try {
    await statusCmd(srv.url, { fleet: richFleet([]), runMeta: async () => meta });
    const out = cap.logs.join("\n");
    assert.match(out, /#7 {2}CI {2}\[acme\/widget\] {2}completed\/success {2}\(push\) {2}2026-08-07 06:42:34Z {2}4\.1s {2}on runner-a/);
    assert.match(out, /#8 {2}release\.yml {2}\[local\] {2}in_progress {2}\(\?\) {2}on runner-b/);
    assert.match(out, /#9 {2}\? {2}\[local\]\s+\(\?\)$/m); // no meta → plain line, no trailing extras
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("statusCmd: a filter-skipped run renders basename + (skipped) and a — time placeholder (#140)", async () => {
  const srv = await runsServing([
    { id: 7, fileName: ".github/workflows/ci.yml", displayName: ".github/workflows/ci.yml", status: "completed", result: "skipped", eventName: "push", owner: "team", repo: "app" },
  ]);
  const cap = capture();
  try {
    await statusCmd(srv.url, { fleet: richFleet([]), runMeta: noMeta });
    const out = cap.logs.join("\n");
    assert.match(out, /#7 {2}ci\.yml \(skipped\) {2}\[team\/app\] {2}completed\/skipped {2}\(push\) {2}—$/m);
    assert.doesNotMatch(out, /\.github\/workflows/, "the raw workflow path never renders as a name");
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("statusCmd: no runs → (no runs yet)", async () => {
  const srv = await runsServing([]);
  const cap = capture();
  try {
    await statusCmd(srv.url, { fleet: richFleet([]), runMeta: noMeta });
    assert.match(cap.logs.join("\n"), /\(no runs yet\)/);
  } finally {
    cap.restore();
    await srv.close();
  }
});

test("statusCmd: a non-connection error (e.g. a live hub's 5xx) still surfaces unchanged", async () => {
  // fleet resolves ok; the runs fetch 500s → a non-connection error must propagate (reject).
  const srv = await startServer((_req, res) => {
    res.writeHead(503);
    res.end("down");
  });
  try {
    await assert.rejects(() => statusCmd(srv.url, { fleet: richFleet([]), runMeta: noMeta }), /workflow\/runs.*503|: 503/);
  } finally {
    await srv.close();
  }
});

test("statusCmd: an unreachable hub prints one [ndh] line + the underlying error, exits 1 (#69)", async () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  try {
    // The fallback fleet fetch fails with a connection error — the same surface as a down hub.
    const connErr = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6099"), { code: "ECONNREFUSED" }) });
    const code = await statusCmd("http://127.0.0.1:6099", {
      fleet: async () => {
        throw connErr;
      },
      runMeta: noMeta,
    });
    assert.equal(code, 1);
    const out = errs.join("\n");
    assert.match(out, /can't reach the hub at http:\/\/127\.0\.0\.1:6099/);
    assert.match(out, /ndh hub up/);
    assert.match(out, /ECONNREFUSED/);
  } finally {
    console.error = orig;
  }
});
