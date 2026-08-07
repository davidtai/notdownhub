// Shared test fixtures. Lives under src/test/ so it compiles to dist/test/ and is excluded from
// coverage (dist/test/**). Not a *.test.ts file, so node --test never runs it as a suite.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";

/** Fresh, isolated NDH_HOME (+ deterministic file secrets backend). Returns the temp home. */
export function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ndh-cov-"));
  process.env.NDH_HOME = home;
  process.env.NDH_SECRETS_BACKEND = "file";
  return home;
}

export interface Fixture {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Start an ephemeral (port 0) HTTP server with the given handler; resolves once listening. */
export function startServer(handler: http.RequestListener): Promise<Fixture> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Read the full request body as a Buffer. */
export function body(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Build a tiny .tar.gz at `dest` containing the given files (relative name -> contents). Used to
 * fake the vendored runner bundle without the real 66MB download.
 */
export function makeTarGz(dest: string, files: Record<string, string>): void {
  const src = mkdtempSync(join(tmpdir(), "ndh-tar-"));
  for (const [name, contents] of Object.entries(files)) {
    const p = join(src, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contents, { mode: 0o755 });
  }
  mkdirSync(dirname(dest), { recursive: true });
  const r = spawnSync("tar", ["-czf", dest, "-C", src, "."], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("failed to build tar fixture");
}

/**
 * Write a fake `security` executable (macOS Keychain CLI shim) into a temp dir and return that dir.
 * Prepend it to PATH to exercise the keychain backend cross-platform. Stores values in a JSON file.
 * A value of "FAILWRITE" makes add-generic-password exit non-zero (to test the write-failure path).
 */
export function fakeSecurityDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ndh-sec-"));
  const store = join(dir, "store.json");
  writeFileSync(store, "{}");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const store = ${JSON.stringify(store)};
const read = () => { try { return JSON.parse(fs.readFileSync(store, "utf8")); } catch { return {}; } };
const write = (o) => fs.writeFileSync(store, JSON.stringify(o));
const a = process.argv.slice(2);
const cmd = a[0];
const opt = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
const key = (opt("-s") || "") + "\\u0000" + (opt("-a") || "");
if (cmd === "add-generic-password") {
  const w = opt("-w");
  // ndh base64-encodes values before -w; decode to detect the sentinel like the real value.
  const decoded = Buffer.from(w || "", "base64").toString("utf8");
  if (decoded === "FAILWRITE") { process.stderr.write("simulated failure"); process.exit(1); }
  const o = read(); o[key] = w; write(o); process.exit(0);
} else if (cmd === "find-generic-password") {
  const o = read();
  if (!(key in o)) process.exit(44);
  process.stdout.write(o[key] + "\\n"); process.exit(0);
} else if (cmd === "delete-generic-password") {
  const o = read(); if (key in o) { delete o[key]; write(o); process.exit(0); } process.exit(44);
}
process.exit(2);
`;
  const exe = join(dir, "security");
  writeFileSync(exe, script, { mode: 0o755 });
  chmodSync(exe, 0o755);
  return dir;
}

/** Absolute path to the built CLI entrypoint (dist/index.js). */
export function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the built CLI as a real subprocess (async, so an in-process fixture server can still respond —
 * execFileSync would block the event loop and deadlock against a same-process server).
 */
export function runCli(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath(), ...args], {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    child.on("close", (code) => resolve({ status: code ?? 0, stdout, stderr }));
  });
}
