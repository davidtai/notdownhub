import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAddCmd, reportRunsOn, setupLines } from "../project-add.js";
import { parseWorkflowInfo } from "../workflowinfo.js";
import { freshHome, startServer, body, runCli, type Fixture } from "./helpers.js";

const YAML = `
name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: [self-hosted, gpu]
    steps: [{ run: "true" }]
`;

function writeWorkflow(text = YAML): string {
  const dir = mkdtempSync(join(tmpdir(), "ndh-pa-"));
  const p = join(dir, "ci.yml");
  writeFileSync(p, text);
  return p;
}

/** Fake hub front: agents list + the placeholder route (recording the POSTed body). */
async function fakeHub(opts: { placeholderStatus?: number; agents?: unknown } = {}): Promise<
  Fixture & { posted: unknown[] }
> {
  const posted: unknown[] = [];
  const f = await startServer(async (rq, res) => {
    const u = new URL(rq.url ?? "/", "http://x");
    if (u.pathname === "/api/local/agents") {
      res.end(JSON.stringify(opts.agents ?? [{ labels: ["self-hosted", "linux"] }]));
      return;
    }
    if (u.pathname === "/api/local/projects/placeholder" && rq.method === "POST") {
      posted.push(JSON.parse((await body(rq)).toString()));
      res.writeHead(opts.placeholderStatus ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { ...f, posted };
}

function capture(): { lines: string[]; log: () => void; err: () => void; restore: () => void } {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  return {
    lines,
    log: () => {},
    err: () => {},
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

test("project add: parses the YAML, warns on unmatched runs-on, creates the placeholder, prints setup", async () => {
  freshHome();
  const hub = await fakeHub();
  const cap = capture();
  try {
    const code = await projectAddCmd({ workflow: writeWorkflow(), repository: "acme/app", server: hub.url });
    assert.equal(code, 0);
  } finally {
    cap.restore();
    await hub.close();
  }
  const out = cap.lines.join("\n");
  assert.match(out, /workflow: CI \(ci\.yml, 1 job\)/);
  assert.match(out, /on: push/);
  assert.match(out, /branches: main/);
  assert.match(out, /runs-on: self-hosted — matched/);
  assert.match(out, /warning: no runner in the current fleet matches runs-on 'gpu'/);
  assert.match(out, /planned project acme\/app registered/);
  assert.match(out, /ndh dispatch --server .* --repository acme\/app/);
  assert.match(out, /ndh hook install \/srv\/git\/app\.git/);
  // The placeholder went through the hub's own route with the parsed facts.
  assert.equal(hub.posted.length, 1);
  const posted = hub.posted[0] as Record<string, unknown>;
  assert.equal(posted.slug, "acme/app");
  assert.equal(posted.workflowName, "CI");
  assert.equal(posted.workflowFileName, "ci.yml");
  assert.deepEqual(posted.events, ["push"]);
  assert.deepEqual(posted.branches, ["main"]);
  assert.deepEqual(posted.runsOn, ["self-hosted", "gpu"]);
});

test("project add: derives the slug from the checkout when --repository is absent", async () => {
  freshHome();
  const hub = await fakeHub();
  const cwd = mkdtempSync(join(tmpdir(), "ndh-checkout-"));
  const cap = capture();
  try {
    const code = await projectAddCmd({ workflow: writeWorkflow(), server: hub.url, cwd });
    assert.equal(code, 0);
  } finally {
    cap.restore();
    await hub.close();
  }
  // No origin remote → #59's local/<dir> fallback slug, exactly like a dispatch from there.
  const posted = hub.posted[0] as { slug: string };
  assert.match(posted.slug, /^local\//);
});

test("project add: honest failures — unreadable file, bad YAML, invalid slug, hub 403, hub down", async () => {
  freshHome();
  const cap = capture();
  try {
    assert.equal(await projectAddCmd({ workflow: "/nope/missing.yml", server: "http://127.0.0.1:1" }), 1);
    assert.equal(await projectAddCmd({ workflow: writeWorkflow("jobs: {}"), server: "http://127.0.0.1:1" }), 1);
    assert.equal(
      await projectAddCmd({ workflow: writeWorkflow(), repository: "not-a-slug", server: "http://127.0.0.1:1" }),
      1,
    );
    const gated = await fakeHub({ placeholderStatus: 403 });
    assert.equal(await projectAddCmd({ workflow: writeWorkflow(), repository: "a/b", server: gated.url }), 1);
    await gated.close();
    const erroring = await fakeHub({ placeholderStatus: 500 });
    assert.equal(await projectAddCmd({ workflow: writeWorkflow(), repository: "a/b", server: erroring.url }), 1);
    await erroring.close();
    // Nothing listening at all → unreachable.
    assert.equal(
      await projectAddCmd({ workflow: writeWorkflow(), repository: "a/b", server: "http://127.0.0.1:1" }),
      1,
    );
  } finally {
    cap.restore();
  }
  const out = cap.lines.join("\n");
  assert.match(out, /cannot read workflow file/);
  assert.match(out, /jobs: block is empty/);
  assert.match(out, /invalid project slug/);
  assert.match(out, /loopback-only/);
  assert.match(out, /hub returned 500/);
  assert.match(out, /hub unreachable/);
});

test("reportRunsOn: unreadable fleet is reported, not guessed; dynamic and hosted labels annotated", () => {
  const info = parseWorkflowInfo(
    "on: push\njobs: { a: { runs-on: [ubuntu-latest, '${{ matrix.os }}'] }, b: { runs-on: x } }",
  );
  const lines: string[] = [];
  const print = (s: string) => lines.push(s);
  // fleet unreadable → no misses claimed
  assert.equal(reportRunsOn(info, null, print), 0);
  assert.match(lines[0], /fleet not readable/);
  // fleet present → hosted + dynamic annotated, real miss counted
  lines.length = 0;
  assert.equal(reportRunsOn(info, ["self-hosted"], print), 1);
  assert.match(lines.join("\n"), /hosted label/);
  assert.match(lines.join("\n"), /resolved at run time/);
  assert.match(lines.join("\n"), /no runner in the current fleet matches runs-on 'x'/);
  // no runs-on at all → nothing to say
  assert.equal(reportRunsOn(parseWorkflowInfo("on: push\njobs: { a: {} }"), ["z"], print), 0);
});

test("setupLines: dispatch + hook install tailored to the slug", () => {
  const lines = setupLines("http://hub:4949", "acme/app");
  assert.deepEqual(lines, [
    "ndh dispatch --server http://hub:4949 --repository acme/app",
    "ndh hook install /srv/git/app.git --server http://hub:4949 --repository acme/app",
  ]);
});

test("ndh project add --help registers under the project command (CLI wiring)", async () => {
  const r = await runCli(["project", "add", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--workflow <path>/);
  assert.match(r.stdout, /--repository <owner\/repo>/);
});
