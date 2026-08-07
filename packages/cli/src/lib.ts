import { createWriteStream } from "node:fs";
import { mkdir, stat, rename, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileLogActive, fileLogLine, fileLogWrite } from "./filelog.js";

export const VENDOR_VERSION = "3.14.0";
export const VENDOR_TAG = `v${VENDOR_VERSION}`;

export function ndhHome(): string {
  return process.env.NDH_HOME ?? join(homedir(), ".notdownhub");
}

/** The hub's own SQLite database (runs, jobs, agents, timelines). */
export function hubDbPath(): string {
  return join(ndhHome(), "hub", "hub.db");
}

/** Write pretty JSON to a 0600 file, creating its parent directory. Used by the local scoped stores. */
export async function writeJson0600(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

export function vendorDir(): string {
  return join(ndhHome(), "vendor", `runner.server-${VENDOR_VERSION}`);
}

export function vendorRid(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  switch (process.platform) {
    case "darwin":
      return `osx-${arch}`;
    case "linux":
      return `linux-${arch}`;
    case "win32":
      return `win-${arch}`;
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

export function vendorExe(name: string): string {
  return join(vendorDir(), process.platform === "win32" ? `${name}.exe` : name);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function download(url: string, dest: string, opts: { headers?: Record<string, string> } = {}): Promise<void> {
  const res = await fetch(url, { redirect: "follow", headers: opts.headers });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  await mkdir(join(dest, ".."), { recursive: true });
  const tmp = `${dest}.partial`;
  const out = createWriteStream(tmp);
  try {
    // pipeline (unlike .pipe) forwards a source error and destroys both streams, so an
    // interrupted download rejects cleanly instead of throwing an unhandled 'error' event.
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), out);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new Error(`download failed: ${(err as Error).message} for ${url}`);
  }
  await rename(tmp, dest);
}

export async function extractTarGz(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const r = spawnSync("tar", ["-xzf", archive, "-C", dest], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`tar extraction failed for ${archive}`);
}

export function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    // With a file log active, child output is piped so it can be teed to the log as well.
    // (Piping costs TTY detection in the child — its output loses color; the file stays plain.)
    const tee = fileLogActive();
    const child = spawn(cmd, args, { stdio: tee ? ["inherit", "pipe", "pipe"] : "inherit", ...opts });
    if (tee) {
      child.stdout?.on("data", (d: Buffer) => {
        process.stdout.write(d);
        fileLogWrite(d);
      });
      child.stderr?.on("data", (d: Buffer) => {
        process.stderr.write(d);
        fileLogWrite(d);
      });
    }
    // Resolve on 'close' (all stdio EOF), not 'exit', so teed 'data' events are fully
    // delivered before the caller exits — otherwise the tail of the log is truncated.
    let exitCode = 1;
    const signals = ["SIGINT", "SIGTERM"] as const;
    const onSignal: Record<string, () => void> = {};
    const cleanup = () => {
      for (const sig of signals) process.removeListener(sig, onSignal[sig]);
    };
    for (const sig of signals) {
      onSignal[sig] = () => child.kill(sig);
      process.on(sig, onSignal[sig]);
    }
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("exit", (code, signal) => {
      exitCode = signal ? 1 : code ?? 1;
    });
    child.on("close", () => {
      cleanup();
      resolve(exitCode);
    });
  });
}

/** Unwrap a hub REST response that may be a bare array or an OData `{ value: [...] }` envelope. */
export function unwrap<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : ((data as { value?: T[] })?.value ?? []);
}

// ── Hub reachability ──────────────────────────────────────────────────────────
// Connection-level failures a --server URL can hit: the port isn't listening (hub
// down / wrong port), the host doesn't resolve (wrong --server), or the connection
// times out. These are the "your hub isn't up" cases we translate into one human line.
const CONN_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
]);

/** The connection-level error code buried in an error (or its `cause` chain), if any. */
export function connErrorCode(err: unknown): string | null {
  let e: unknown = err;
  const seen = new Set<unknown>();
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CONN_ERROR_CODES.has(code)) return code;
    // fetch() aborts (our probe timeout) surface as AbortError, not a code.
    if ((e as { name?: unknown }).name === "AbortError") return "ETIMEDOUT";
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** The deepest `message` in an error's `cause` chain — e.g. "connect ECONNREFUSED 127.0.0.1:6099". */
export function rootErrorMessage(err: unknown): string {
  let e: unknown = err;
  let msg = String((err as { message?: unknown })?.message ?? err);
  const seen = new Set<unknown>();
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m) msg = m;
    e = (e as { cause?: unknown }).cause;
  }
  return msg;
}

/** The standard [ndh] line for a hub URL we could not reach. */
export function hubUnreachableMessage(url: string): string {
  return `can't reach the hub at ${url} — is it up? (ndh hub up) and is --server correct?`;
}

export interface Reachability {
  ok: boolean;
  /** connection error code when !ok (ECONNREFUSED, ENOTFOUND, …). */
  code?: string;
  /** underlying error message, kept for the debug line when !ok. */
  detail?: string;
}

/**
 * Probe a --server URL: reachable when the host answers at all (any HTTP status counts —
 * even a 401/404 proves the port is listening), unreachable only on a connection-level
 * failure. Bounded by a timeout so a black-holed host can't hang the command. A non-
 * connection fetch error is treated as reachable, so the real command can surface its own
 * precise error rather than a misleading "can't reach the hub".
 */
export async function probeServer(url: string, timeoutMs = 5000): Promise<Reachability> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, { method: "HEAD", signal: ctrl.signal });
    return { ok: true };
  } catch (err) {
    const code = connErrorCode(err);
    if (code) return { ok: false, code, detail: rootErrorMessage(err) };
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

export function log(msg: string): void {
  console.error(`\x1b[36m[ndh]\x1b[0m ${msg}`);
  fileLogLine(`[ndh] ${msg}`);
}

export function fail(msg: string): never {
  console.error(`\x1b[31m[ndh]\x1b[0m ${msg}`);
  fileLogLine(`[ndh] FATAL ${msg}`);
  process.exit(1);
}

export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Human byte size, e.g. 0 B, 158 B, 1.2 KB, 3.4 MB. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
