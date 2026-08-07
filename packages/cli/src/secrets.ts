import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ndhHome, fail, log } from "./lib.js";

/**
 * Local secrets storage for `ndh` (issue #3).
 *
 * Scopes:
 *   "global"        secrets injected into every `ndh run` / `ndh dispatch`
 *   "<owner>/<name>" secrets injected only when run from that repo (override global)
 *
 * Backends:
 *   macOS   → the login Keychain via the `security` CLI. This is the real, OS-guarded store.
 *   other   → ~/.notdownhub/secrets.json (0600) with values encrypted with AES-256-GCM
 *             (key in ~/.notdownhub/secrets.key, 0600). This is OBFUSCATION-AT-REST only —
 *             anyone who can read the key file can read the values; the Keychain is the real
 *             backend. It exists so Linux/Windows/CI still work.
 *
 * A names+scopes index (~/.notdownhub/secrets-index.json) is the source of truth for `list`
 * so listing never has to touch the value store. It never contains values.
 *
 * GITHUB_TOKEN: if you store a secret named GITHUB_TOKEN it is injected like any other secret,
 * exposed to workflows as ${{ secrets.GITHUB_TOKEN }}. It is independent of the hub's own
 * `--github-token` (used for the action mirror) and of any GITHUB_TOKEN in your shell env.
 */

export const GLOBAL_SCOPE = "global";
const KEYCHAIN_PREFIX = () => process.env.NDH_KEYCHAIN_SERVICE ?? "notdownhub";

export interface IndexEntry {
  name: string;
  scope: string;
}

function backend(): "keychain" | "file" {
  const forced = process.env.NDH_SECRETS_BACKEND;
  if (forced === "file") return "file";
  if (forced === "keychain") return "keychain";
  return process.platform === "darwin" ? "keychain" : "file";
}

export function backendName(): string {
  return backend() === "keychain" ? "macOS Keychain" : "encrypted file (obfuscation-at-rest)";
}

// ---------- name index (names + scopes only, never values) ----------

function indexPath(): string {
  return join(ndhHome(), "secrets-index.json");
}

async function readIndex(): Promise<IndexEntry[]> {
  try {
    const raw = await readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw) as IndexEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(entries: IndexEntry[]): Promise<void> {
  await mkdir(ndhHome(), { recursive: true });
  await writeFile(indexPath(), `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  await chmod(indexPath(), 0o600).catch(() => {});
}

async function indexAdd(name: string, scope: string): Promise<void> {
  const entries = await readIndex();
  if (!entries.some((e) => e.name === name && e.scope === scope)) {
    entries.push({ name, scope });
    entries.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
    await writeIndex(entries);
  }
}

async function indexRemove(name: string, scope: string): Promise<void> {
  const entries = await readIndex();
  const next = entries.filter((e) => !(e.name === name && e.scope === scope));
  if (next.length !== entries.length) await writeIndex(next);
}

// ---------- keychain backend (macOS) ----------

function keychainService(scope: string): string {
  return `${KEYCHAIN_PREFIX()}:${scope}`;
}

function keychainSet(scope: string, name: string, value: string): void {
  // Note: `security` takes the value on argv (`-w <value>`). This briefly exposes the value to
  // `ps` during the call — it is macOS's sanctioned CLI for writing the Keychain and there is no
  // stdin form (the interactive `-w` prompt requires a retype confirmation). Our own injection
  // path into the runner never uses argv (see secret-file below).
  const r = spawnSync(
    "security",
    ["add-generic-password", "-U", "-s", keychainService(scope), "-a", name, "-w", value],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (r.status !== 0) throw new Error(`keychain write failed: ${r.stderr?.toString().trim() || r.status}`);
}

function keychainGet(scope: string, name: string): string | null {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", keychainService(scope), "-a", name, "-w"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (r.status !== 0) return null;
  // `security -w` prints the value followed by a newline.
  return r.stdout.toString().replace(/\n$/, "");
}

function keychainDelete(scope: string, name: string): void {
  spawnSync("security", ["delete-generic-password", "-s", keychainService(scope), "-a", name], {
    stdio: "ignore",
  });
}

// ---------- file backend (encrypted-at-rest fallback) ----------

function secretsFilePath(): string {
  return join(ndhHome(), "secrets.json");
}

function keyFilePath(): string {
  return join(ndhHome(), "secrets.key");
}

async function loadKey(): Promise<Buffer> {
  try {
    const b64 = (await readFile(keyFilePath(), "utf8")).trim();
    const key = Buffer.from(b64, "base64");
    if (key.length === 32) return key;
  } catch {
    /* fall through and create */
  }
  const key = randomBytes(32);
  await mkdir(ndhHome(), { recursive: true });
  await writeFile(keyFilePath(), `${key.toString("base64")}\n`, { mode: 0o600 });
  await chmod(keyFilePath(), 0o600).catch(() => {});
  return key;
}

async function encrypt(value: string): Promise<string> {
  const key = await loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

async function decrypt(blob: string): Promise<string> {
  const key = await loadKey();
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

type FileStore = Record<string, Record<string, string>>;

async function readFileStore(): Promise<FileStore> {
  try {
    return JSON.parse(await readFile(secretsFilePath(), "utf8")) as FileStore;
  } catch {
    return {};
  }
}

async function writeFileStore(store: FileStore): Promise<void> {
  await mkdir(ndhHome(), { recursive: true });
  await writeFile(secretsFilePath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(secretsFilePath(), 0o600).catch(() => {});
}

async function fileSet(scope: string, name: string, value: string): Promise<void> {
  const store = await readFileStore();
  (store[scope] ??= {})[name] = await encrypt(value);
  await writeFileStore(store);
}

async function fileGet(scope: string, name: string): Promise<string | null> {
  const store = await readFileStore();
  const blob = store[scope]?.[name];
  if (blob === undefined) return null;
  return decrypt(blob);
}

async function fileDelete(scope: string, name: string): Promise<void> {
  const store = await readFileStore();
  if (store[scope]) {
    delete store[scope][name];
    if (Object.keys(store[scope]).length === 0) delete store[scope];
    await writeFileStore(store);
  }
}

// ---------- public store API ----------

export async function setSecret(scope: string, name: string, value: string): Promise<void> {
  if (backend() === "keychain") keychainSet(scope, name, value);
  else await fileSet(scope, name, value);
  await indexAdd(name, scope);
}

export async function getSecret(scope: string, name: string): Promise<string | null> {
  return backend() === "keychain" ? keychainGet(scope, name) : fileGet(scope, name);
}

export async function removeSecret(scope: string, name: string): Promise<boolean> {
  const existed = (await readIndex()).some((e) => e.name === name && e.scope === scope);
  if (backend() === "keychain") keychainDelete(scope, name);
  else await fileDelete(scope, name);
  await indexRemove(name, scope);
  return existed;
}

export async function listSecrets(scope?: string): Promise<IndexEntry[]> {
  const entries = await readIndex();
  return scope ? entries.filter((e) => e.scope === scope) : entries;
}

// ---------- repo slug detection ----------

export function currentRepoSlug(cwd: string = process.cwd()): string | null {
  const r = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return null;
  const url = r.stdout.toString().trim();
  if (!url) return null;
  // git@github.com:owner/name.git  |  https://github.com/owner/name(.git)
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

// ---------- secret-file (GITHUB_ENV syntax) injection ----------

/** Resolve the effective secret set for a run: global first, then repo overrides by name. */
export async function resolveSecretsForRun(repoSlug: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const scopes = repoSlug ? [GLOBAL_SCOPE, repoSlug] : [GLOBAL_SCOPE];
  for (const scope of scopes) {
    for (const { name } of await listSecrets(scope)) {
      const value = await getSecret(scope, name);
      if (value !== null) out.set(name, value); // later scope (repo) overrides earlier (global)
    }
  }
  return out;
}

/**
 * Serialize secrets in GitHub `GITHUB_ENV` file syntax:
 *   NAME=value                    (single-line)
 *   NAME<<__delim__ ... __delim__ (multi-line, heredoc)
 * The delimiter is randomized per key and guaranteed not to occur in the value.
 */
export function formatSecretFile(entries: Map<string, string>): string {
  const lines: string[] = [];
  for (const [name, value] of entries) {
    if (value.includes("\n") || /[\r]/.test(value)) {
      let delim = `ndh_${randomBytes(12).toString("hex")}`;
      while (value.includes(delim)) delim = `ndh_${randomBytes(12).toString("hex")}`;
      lines.push(`${name}<<${delim}`, value.replace(/\r\n/g, "\n"), delim);
    } else {
      lines.push(`${name}=${value}`);
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Write the secret file to a 0600 temp path. Returns the path (caller must shred it). */
export async function writeSecretFile(entries: Map<string, string>): Promise<string> {
  const dir = join(tmpdir(), "ndh-secrets");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const path = join(dir, `secrets-${randomBytes(12).toString("hex")}.env`);
  await writeFile(path, formatSecretFile(entries), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return path;
}

async function shred(path: string): Promise<void> {
  try {
    const size = (await readFile(path)).length;
    if (size > 0) await writeFile(path, Buffer.alloc(size, 0), { mode: 0o600 });
  } catch {
    /* ignore */
  }
  await rm(path, { force: true }).catch(() => {});
}

/**
 * Load global + repo secrets, write them to an ephemeral 0600 secret file, invoke `run` with the
 * extra Runner.Client args (`--secret-file <path>`), and shred+delete the file in a finally block.
 * Secret VALUES never touch argv or logs — only the file path does.
 */
export async function withRunnerSecrets<T>(
  repoSlug: string | null,
  run: (extraArgs: string[]) => Promise<T>,
): Promise<T> {
  const entries = await resolveSecretsForRun(repoSlug);
  if (entries.size === 0) return run([]);
  const path = await writeSecretFile(entries);
  log(`injecting ${entries.size} secret${entries.size === 1 ? "" : "s"} via ephemeral secret-file`);
  try {
    return await run(["--secret-file", path]);
  } finally {
    await shred(path);
  }
}

// ---------- hidden value prompt ----------

/** Read a secret value: --value wins; else piped stdin (whole input); else hidden TTY prompt. */
export async function readSecretValue(valueFlag: string | undefined): Promise<string> {
  if (valueFlag !== undefined) return valueFlag;
  if (!process.stdin.isTTY) {
    // scripting: `echo -n value | ndh secrets set NAME`  (supports multi-line)
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  return promptHidden("value (input hidden): ");
}

/* c8 ignore start -- interactive hidden-input prompt: needs a real raw-mode TTY (setRawMode + keypress
   handling), which the test harness has no way to drive. The non-TTY (--value / piped stdin) paths in
   readSecretValue ARE covered; only this terminal path is excluded. */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const finish = (fn: () => void) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      fn();
    };
    const onData = (ch: string) => {
      for (const c of ch) {
        const code = c.charCodeAt(0);
        if (c === "\n" || c === "\r" || code === 4 /* Ctrl-D */) {
          finish(() => {
            process.stderr.write("\n");
            resolve(buf);
          });
          return;
        } else if (code === 3 /* Ctrl-C */) {
          finish(() => reject(new Error("aborted")));
          return;
        } else if (code === 127 || code === 8 /* DEL / Backspace */) {
          buf = buf.slice(0, -1);
        } else {
          buf += c;
        }
      }
    };
    stdin.on("data", onData);
  });
}

// ---------- commander wiring ----------

type RepoOpt = string | boolean | undefined;

/** Resolve the scope from a `--repo [slug]` option. Absent → global (for set/rm). */
function scopeFromRepo(repo: RepoOpt): string {
  if (typeof repo === "string") return repo;
  if (repo === true) {
    const slug = currentRepoSlug();
    if (!slug) fail("not inside a git repo with an origin remote — pass --repo owner/name");
    return slug;
  }
  return GLOBAL_SCOPE; // option absent
}

export function registerSecrets(program: Command): void {
  const secrets = program
    .command("secrets")
    .description("store secrets locally and auto-inject them into `ndh run` / `ndh dispatch`")
    .addHelpText(
      "after",
      `\nbackend: ${backendName()}\nscopes:  global (default) or a repo via --repo owner/name (repo overrides global)\n` +
        "values:  provided by hidden prompt, piped stdin (echo -n val | ndh secrets set NAME), or --value\n" +
        "GITHUB_TOKEN: a secret named GITHUB_TOKEN is injected as ${{ secrets.GITHUB_TOKEN }};\n" +
        "  it is separate from the hub's --github-token (action mirror) and any shell GITHUB_TOKEN.",
    )
    .action(() => {
      secrets.help();
    });

  secrets
    .command("set")
    .description("store a secret (value via hidden prompt, piped stdin, or --value)")
    .argument("<name>", "secret name, e.g. NPM_TOKEN")
    .option("--repo [slug]", "scope to a repo (owner/name, or current repo if no value); default global")
    .option("--value <value>", "provide the value inline (scripting; avoid on shared shells)")
    .action(async (name: string, opts: { repo?: RepoOpt; value?: string }) => {
      const scope = scopeFromRepo(opts.repo);
      const value = await readSecretValue(opts.value);
      if (value === "") fail("empty secret value");
      await setSecret(scope, name, value);
      log(`stored ${name} (scope: ${scope}, backend: ${backendName()})`);
      process.exitCode = 0;
    });

  secrets
    .command("get")
    .description("print a secret value (explicit retrieval — the only command that reveals a value)")
    .argument("<name>", "secret name")
    .option("--repo [slug]", "scope to a repo (owner/name, or current repo); default global")
    .action(async (name: string, opts: { repo?: RepoOpt }) => {
      const scope = scopeFromRepo(opts.repo);
      const value = await getSecret(scope, name);
      if (value === null) fail(`no secret '${name}' in scope '${scope}'`);
      process.stdout.write(`${value}\n`);
      process.exitCode = 0;
    });

  secrets
    .command("list")
    .alias("ls")
    .description("list secret names + scopes (never values)")
    .option("--repo [slug]", "filter to a repo scope (owner/name, or current repo)")
    .action(async (opts: { repo?: RepoOpt }) => {
      const scope = opts.repo === undefined ? undefined : scopeFromRepo(opts.repo);
      const entries = await listSecrets(scope);
      if (entries.length === 0) {
        console.log("(no secrets)");
      } else {
        for (const e of entries) console.log(`${e.scope}\t${e.name}`);
      }
      process.exitCode = 0;
    });

  secrets
    .command("rm")
    .alias("remove")
    .description("delete a secret")
    .argument("<name>", "secret name")
    .option("--repo [slug]", "scope to a repo (owner/name, or current repo); default global")
    .action(async (name: string, opts: { repo?: RepoOpt }) => {
      const scope = scopeFromRepo(opts.repo);
      const existed = await removeSecret(scope, name);
      log(existed ? `removed ${name} (scope: ${scope})` : `no secret '${name}' in scope '${scope}'`);
      process.exitCode = 0;
    });
}

// ---------- exposed for tests ----------

export const __test = { shred, indexPath, secretsFilePath, keyFilePath };
