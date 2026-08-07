import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setVar, getVar, listVars, removeVar, resolveVarsForRun, withRunnerVars, __test } from "../vars.js";
import { setSecret, GLOBAL_SCOPE } from "../secrets.js";
import { runCmd } from "../runcmd.js";

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ndh-vars-test-"));
  process.env.NDH_HOME = home;
  process.env.NDH_SECRETS_BACKEND = "file";
  return home;
}

test("vars: set / get / list / rm round-trip in plain 0600 store", async () => {
  freshHome();
  await setVar(GLOBAL_SCOPE, "REGION", "eu-west-1");
  await setVar("o/r", "REGION", "us-east-1");
  await setVar("o/r", "STAGE", "prod");

  assert.equal(await getVar(GLOBAL_SCOPE, "REGION"), "eu-west-1");
  assert.equal(await getVar("o/r", "REGION"), "us-east-1");
  assert.equal(await getVar("o/r", "MISSING"), null);

  // list shows values (vars are not secret) and the file is plain JSON, 0600
  const all = await listVars();
  assert.equal(all.length, 3);
  assert.ok(all.some((e) => e.value === "eu-west-1"));
  const raw = readFileSync(__test.varsFilePath(), "utf8");
  assert.ok(raw.includes("eu-west-1"), "vars are stored in plain text by design");
  assert.equal(statSync(__test.varsFilePath()).mode & 0o777, 0o600);

  assert.equal(await removeVar("o/r", "STAGE"), true);
  assert.equal(await removeVar("o/r", "STAGE"), false);
  assert.deepEqual((await listVars("o/r")).map((e) => e.name), ["REGION"]);
});

test("vars: repo scope overrides global in run resolution", async () => {
  freshHome();
  await setVar(GLOBAL_SCOPE, "SHARED", "global");
  await setVar(GLOBAL_SCOPE, "ONLY_GLOBAL", "g");
  await setVar("o/r", "SHARED", "repo");

  const globalOnly = await resolveVarsForRun(null);
  assert.equal(globalOnly.get("SHARED"), "global");

  const withRepo = await resolveVarsForRun("o/r");
  assert.equal(withRepo.get("SHARED"), "repo");
  assert.equal(withRepo.get("ONLY_GLOBAL"), "g");
});

test("withRunnerVars: ephemeral --var-file with JSON payload, removed after", async () => {
  freshHome();
  await setVar(GLOBAL_SCOPE, "A", "1");
  await setVar(GLOBAL_SCOPE, "MULTI", "line1\nline2");

  let varFile = "";
  let contents = "";
  const code = await withRunnerVars(null, async (extra) => {
    assert.equal(extra[0], "--var-file");
    varFile = extra[1];
    contents = readFileSync(varFile, "utf8");
    return 0;
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(contents) as Record<string, string>;
  assert.equal(parsed.A, "1");
  assert.equal(parsed.MULTI, "line1\nline2");
  assert.equal(existsSync(varFile), false, "var-file must be deleted after the run");
});

test("withRunnerVars: no vars → no extra args", async () => {
  freshHome();
  let extraSeen: string[] | null = null;
  await withRunnerVars(null, async (extra) => {
    extraSeen = extra;
    return 0;
  });
  assert.deepEqual(extraSeen, []);
});

test("runCmd injects secrets and vars separately, in that order, before user args", async () => {
  freshHome();
  await setSecret(GLOBAL_SCOPE, "TOKEN", "sekret");
  await setVar(GLOBAL_SCOPE, "STAGE", "prod");

  let captured: string[] = [];
  await runCmd(["--event", "push"], {
    runner: async (_cmd, args) => {
      captured = args;
      return 0;
    },
    ensure: async () => 0,
    repoSlug: () => null,
  });

  const iSecret = captured.indexOf("--secret-file");
  const iVar = captured.indexOf("--var-file");
  const iUser = captured.indexOf("--event");
  assert.ok(iSecret !== -1 && iVar !== -1 && iUser !== -1);
  assert.ok(iSecret < iVar && iVar < iUser, "order: secret-file, var-file, then user args");
  assert.ok(!JSON.stringify(captured).includes("sekret"), "secret value never on argv");
});
