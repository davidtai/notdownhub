import { createWriteStream } from "node:fs";
import { mkdir, stat, rename, rm } from "node:fs/promises";
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
