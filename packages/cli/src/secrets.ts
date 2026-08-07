import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ndhHome, fail, log, writeJson0600 } from "./lib.js";
import { GLOBAL_SCOPE, currentRepoSlug, runScopes, scopeFromRepo, type RepoOpt } from "./scope.js";

// Re-export so existing importers (vars.ts, runcmd.ts) keep working after the scope split.
export { GLOBAL_SCOPE, currentRepoSlug } from "./scope.js";

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

const KEYCHAIN_PREFIX = () => process.env.NDH_KEYCHAIN_SERVICE ?? "notdownhub";

export interface IndexEntry {
  name: string;
  scope: string;
}

/** Linux Secret Service (libsecret) is usable when secret-tool exists and a session bus is up. */
function libsecretAvailable(): boolean {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.XDG_RUNTIME_DIR) return false;
  return spawnSync("secret-tool", ["--help"], { stdio: "ignore" }).status === 0;
}

function togglePath(): string {
  return join(ndhHome(), "secrets-backend");
}

/** Persisted user preference: "keyring" (default) or "file". */
function readToggle(): "keyring" | "file" | null {
  try {
    const v = readFileSync(togglePath(), "utf8").trim();
    return v === "file" || v === "keyring" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Backend resolution, first match wins:
 *   1. NDH_SECRETS_BACKEND env (file | keychain | libsecret) — test/automation override
 *   2. persisted toggle (`ndh secrets backend keyring|file`), default keyring
 *   3. platform keyring: macOS Keychain, or Linux Secret Service when available
 *   4. encrypted file fallback (headless Linux, Windows)
 */
function backend(): "keychain" | "libsecret" | "file" {
  const forced = process.env.NDH_SECRETS_BACKEND;
  if (forced === "file" || forced === "keychain" || forced === "libsecret") return forced;
  if (readToggle() === "file") return "file";
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "linux" && libsecretAvailable()) return "libsecret";
  return "file";
}

export function backendName(): string {
  const b = backend();
  if (b === "keychain") return "macOS Keychain";
  if (b === "libsecret") return "Linux Secret Service (libsecret)";
  return "encrypted file (obfuscation-at-rest)";
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
  await writeJson0600(indexPath(), entries);
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

// `security -w` only prints a value verbatim when every byte is printable ASCII; for any other
// byte (newline, tab, >=0x80) it prints a hex string instead, corrupting multiline/UTF-8 secrets.
// Base64-encoding on write and decoding on read keeps the stored value printable ASCII, so the
// round-trip is lossless for arbitrary bytes.
function keychainSet(scope: string, name: string, value: string): void {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const r = spawnSync(
    "security",
    ["add-generic-password", "-U", "-s", keychainService(scope), "-a", name, "-w", encoded],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (r.status !== 0) {
    const detail = r.stderr?.toString().trim() || r.status;
    // "Unable to obtain authorization" is the classic headless/SSH symptom: no unlocked login
    // Keychain / no GUI session. Name the working fallback inline so the user is not stuck (#42).
    throw new Error(
      `keychain write failed: ${detail}\n` +
        "headless/SSH sessions often cannot unlock the login Keychain — run 'ndh secrets backend file' to use the encrypted-file backend",
    );
  }
}

function keychainGet(scope: string, name: string): string | null {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", keychainService(scope), "-a", name, "-w"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (r.status !== 0) return null;
  return Buffer.from(r.stdout.toString().trim(), "base64").toString("utf8");
}

function keychainDelete(scope: string, name: string): void {
  spawnSync("security", ["delete-generic-password", "-s", keychainService(scope), "-a", name], {
    stdio: "ignore",
  });
}

// ---------- libsecret backend (Linux Secret Service) ----------

function libsecretAttrs(scope: string, name: string): string[] {
  return ["service", KEYCHAIN_PREFIX(), "scope", scope, "name", name];
}

function libsecretSet(scope: string, name: string, value: string): void {
  // secret-tool reads the secret from stdin — the value never appears on argv.
  const r = spawnSync(
    "secret-tool",
    ["store", "--label", `${KEYCHAIN_PREFIX()}:${scope}/${name}`, ...libsecretAttrs(scope, name)],
    { input: value, stdio: ["pipe", "ignore", "pipe"] },
  );
  if (r.status !== 0) {
    throw new Error(
      `libsecret write failed: ${r.stderr?.toString().trim() || r.status} — set NDH_SECRETS_BACKEND=file to use the encrypted-file backend`,
    );
  }
}

function libsecretGet(scope: string, name: string): string | null {
  const r = spawnSync("secret-tool", ["lookup", ...libsecretAttrs(scope, name)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return null;
  // secret-tool prints the raw secret without a trailing newline of its own,
  // but tolerate one in case a shim adds it.
  return r.stdout.toString().replace(/\n$/, "");
}

function libsecretDelete(scope: string, name: string): void {
  spawnSync("secret-tool", ["clear", ...libsecretAttrs(scope, name)], { stdio: "ignore" });
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
  await writeJson0600(secretsFilePath(), store);
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

/** A workflow secret/var name must be a valid environment identifier. */
export function validEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export async function setSecret(scope: string, name: string, value: string): Promise<void> {
  if (!validEnvName(name)) fail(`invalid name '${name}' — use letters, digits, and underscore; must not start with a digit`);
  const b = backend();
  if (b === "keychain") keychainSet(scope, name, value);
  else if (b === "libsecret") libsecretSet(scope, name, value);
  else await fileSet(scope, name, value);
  await indexAdd(name, scope);
}

export async function getSecret(scope: string, name: string): Promise<string | null> {
  const b = backend();
  if (b === "keychain") return keychainGet(scope, name);
  if (b === "libsecret") return libsecretGet(scope, name);
  return fileGet(scope, name);
}

export async function removeSecret(scope: string, name: string): Promise<boolean> {
  const existed = (await readIndex()).some((e) => e.name === name && e.scope === scope);
  const b = backend();
  if (b === "keychain") keychainDelete(scope, name);
  else if (b === "libsecret") libsecretDelete(scope, name);
  else await fileDelete(scope, name);
  await indexRemove(name, scope);
  return existed;
}

export async function listSecrets(scope?: string): Promise<IndexEntry[]> {
  const entries = await readIndex();
  return scope ? entries.filter((e) => e.scope === scope) : entries;
}


// ---------- secret-file (GITHUB_ENV syntax) injection ----------

/** Resolve the effective secret set for a run: global first, then repo overrides by name. */
export async function resolveSecretsForRun(repoSlug: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const scopes = runScopes(repoSlug);
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
    // scripting: `ndh secrets set NAME < deploy_key.pem` — the stored value is the EXACT piped
    // bytes, trailing newline included (#135). PEM keys conventionally end with a newline, and
    // byte-consumers (checksum verification, strict parsers) break if it is silently stripped.
    // Only the interactive prompt below treats a line terminator as "done typing".
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  return promptHidden("value (input hidden): ");
}

/* The interactive hidden prompt reads raw keypresses. Enter/Return only terminates input — the
   typed secret never includes it (#135: contrast with piped stdin above, which is byte-exact).
   Tests drive this with a stubbed process.stdin (setRawMode is optional-chained for that reason). */
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
    .command("backend")
    .description("show or set the secret storage backend (keyring is the default)")
    .argument("[mode]", "keyring or file")
    .action(async (mode?: string) => {
      if (mode === undefined) {
        const toggle = readToggle();
        console.log(`active: ${backendName()}${toggle ? `  (preference: ${toggle})` : "  (default: keyring)"}`);
        process.exitCode = 0;
        return;
      }
      if (mode !== "keyring" && mode !== "file") fail("backend must be 'keyring' or 'file'");
      await mkdir(ndhHome(), { recursive: true });
      await writeFile(togglePath(), `${mode}\n`, { mode: 0o600 });
      log(`secrets backend preference set to ${mode} (active: ${backendName()})`);
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

export const __test = { shred, indexPath, secretsFilePath, keyFilePath, backend, togglePath, libsecretAvailable, promptHidden };
