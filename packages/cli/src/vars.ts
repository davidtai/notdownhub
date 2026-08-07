import { mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ndhHome, fail, log } from "./lib.js";
import { currentRepoSlug, GLOBAL_SCOPE } from "./secrets.js";

/**
 * Plain (non-secret) workflow variables — the `vars` context (`${{ vars.NAME }}`).
 * Deliberately SEPARATE from secrets: different store, different commands, different
 * handling. Values are not sensitive, so they live in a plain 0600 JSON file and
 * `ndh vars list` shows them. Anything sensitive belongs in `ndh secrets`.
 *
 * Store: ~/.notdownhub/vars.json  { "<scope>": { "NAME": "value" } }
 * Scopes: "global" plus "<owner>/<name>" (repo overrides global), same as secrets.
 * Injection: written to an ephemeral file and passed via Runner.Client `--var-file`.
 */

type VarStore = Record<string, Record<string, string>>;

function varsFilePath(): string {
  return join(ndhHome(), "vars.json");
}

async function readStore(): Promise<VarStore> {
  try {
    return JSON.parse(await readFile(varsFilePath(), "utf8")) as VarStore;
  } catch {
    return {};
  }
}

async function writeStore(store: VarStore): Promise<void> {
  await mkdir(ndhHome(), { recursive: true });
  await writeFile(varsFilePath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(varsFilePath(), 0o600).catch(() => {});
}

export async function setVar(scope: string, name: string, value: string): Promise<void> {
  const store = await readStore();
  (store[scope] ??= {})[name] = value;
  await writeStore(store);
}

export async function getVar(scope: string, name: string): Promise<string | null> {
  return (await readStore())[scope]?.[name] ?? null;
}

export async function removeVar(scope: string, name: string): Promise<boolean> {
  const store = await readStore();
  if (store[scope]?.[name] === undefined) return false;
  delete store[scope][name];
  if (Object.keys(store[scope]).length === 0) delete store[scope];
  await writeStore(store);
  return true;
}

export async function listVars(scope?: string): Promise<{ scope: string; name: string; value: string }[]> {
  const store = await readStore();
  const out: { scope: string; name: string; value: string }[] = [];
  for (const [s, entries] of Object.entries(store)) {
    if (scope && s !== scope) continue;
    for (const [name, value] of Object.entries(entries)) out.push({ scope: s, name, value });
  }
  out.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  return out;
}

/** Effective vars for a run: global first, then repo overrides by name. */
export async function resolveVarsForRun(repoSlug: string | null): Promise<Map<string, string>> {
  const store = await readStore();
  const out = new Map<string, string>();
  for (const scope of repoSlug ? [GLOBAL_SCOPE, repoSlug] : [GLOBAL_SCOPE]) {
    for (const [name, value] of Object.entries(store[scope] ?? {})) out.set(name, value);
  }
  return out;
}

/**
 * Write vars to an ephemeral var-file and invoke `run` with the extra Runner.Client args.
 * JSON is valid YAML, so JSON.stringify gives a safe `--var-file` payload for any value.
 */
export async function withRunnerVars<T>(
  repoSlug: string | null,
  run: (extraArgs: string[]) => Promise<T>,
): Promise<T> {
  const entries = await resolveVarsForRun(repoSlug);
  if (entries.size === 0) return run([]);
  const dir = join(tmpdir(), "ndh-vars");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `vars-${randomBytes(12).toString("hex")}.yml`);
  await writeFile(path, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, { mode: 0o600 });
  log(`injecting ${entries.size} var${entries.size === 1 ? "" : "s"} via var-file`);
  try {
    return await run(["--var-file", path]);
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

// ---------- commander wiring ----------

type RepoOpt = string | boolean | undefined;

function scopeFromRepo(repo: RepoOpt): string {
  if (typeof repo === "string") return repo;
  if (repo === true) {
    const slug = currentRepoSlug();
    if (!slug) fail("not inside a git repo with an origin remote — pass --repo owner/name");
    return slug;
  }
  return GLOBAL_SCOPE;
}

export function registerVars(program: Command): void {
  const vars = program
    .command("vars")
    .description("store plain workflow variables (${{ vars.NAME }}) — use `ndh secrets` for anything sensitive")
    .action(() => {
      vars.help();
    });

  vars
    .command("set")
    .description("store a variable")
    .argument("<name>", "variable name, e.g. DEPLOY_TARGET")
    .argument("[value]", "variable value (omit to read from stdin)")
    .option("--repo [slug]", "scope to a repo (owner/name, or current repo); default global")
    .action(async (name: string, value: string | undefined, opts: { repo?: RepoOpt }) => {
      let v = value;
      if (v === undefined) {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        v = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
      }
      if (v === "") fail("empty variable value");
      const scope = scopeFromRepo(opts.repo);
      await setVar(scope, name, v);
      log(`stored var ${name} (scope: ${scope})`);
      process.exitCode = 0;
    });

  vars
    .command("get")
    .description("print a variable value")
    .argument("<name>", "variable name")
    .option("--repo [slug]", "scope to a repo (owner/name, or current repo); default global")
    .action(async (name: string, opts: { repo?: RepoOpt }) => {
      const value = await getVar(scopeFromRepo(opts.repo), name);
      if (value === null) fail(`no var '${name}' in that scope`);
      process.stdout.write(`${value}\n`);
      process.exitCode = 0;
    });

  vars
    .command("list")
    .alias("ls")
    .description("list variables with values (vars are not secret)")
    .option("--repo [slug]", "filter to a repo scope")
    .action(async (opts: { repo?: RepoOpt }) => {
      const scope = opts.repo === undefined ? undefined : scopeFromRepo(opts.repo);
      const entries = await listVars(scope);
      if (entries.length === 0) console.log("(no vars)");
      for (const e of entries) console.log(`${e.scope}\t${e.name}=${e.value}`);
      process.exitCode = 0;
    });

  vars
    .command("rm")
    .alias("remove")
    .description("delete a variable")
    .argument("<name>", "variable name")
    .option("--repo [slug]", "scope to a repo (owner/name, or current repo); default global")
    .action(async (name: string, opts: { repo?: RepoOpt }) => {
      const scope = scopeFromRepo(opts.repo);
      const existed = await removeVar(scope, name);
      log(existed ? `removed var ${name} (scope: ${scope})` : `no var '${name}' in scope '${scope}'`);
      process.exitCode = 0;
    });
}

/** Exposed for tests. */
export const __test = { varsFilePath };
