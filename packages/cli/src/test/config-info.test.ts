import { test } from "node:test";
import assert from "node:assert/strict";
import { getConfigInfo } from "../config-info.js";
import { setSecret } from "../secrets.js";
import { setVar } from "../vars.js";
import { freshHome } from "./helpers.js";

test("getConfigInfo: reports the backend, secret names (no values), and variable values", async () => {
  freshHome(); // file secrets backend + isolated NDH_HOME
  await setSecret("global", "NPM_TOKEN", "s3cr3t");
  await setSecret("owner/repo", "DEPLOY_KEY", "hunter2");
  await setVar("global", "NODE_ENV", "production");

  const cfg = await getConfigInfo();

  assert.equal(typeof cfg.backend, "string");
  assert.ok(cfg.backend.length > 0);

  // secrets carry only scope + name — never a value field
  const secretNames = cfg.secrets.map((s) => `${s.scope}/${s.name}`).sort();
  assert.deepEqual(secretNames, ["global/NPM_TOKEN", "owner/repo/DEPLOY_KEY"]);
  for (const s of cfg.secrets) assert.equal((s as Record<string, unknown>).value, undefined);

  // variables include their (non-sensitive) values
  assert.deepEqual(cfg.vars, [{ scope: "global", name: "NODE_ENV", value: "production" }]);
});

test("getConfigInfo: empty store yields empty lists", async () => {
  freshHome();
  const cfg = await getConfigInfo();
  assert.deepEqual(cfg.secrets, []);
  assert.deepEqual(cfg.vars, []);
});
