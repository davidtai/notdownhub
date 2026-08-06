import { createWriteStream } from "node:fs";
import { mkdir, stat, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

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
  await finished(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).pipe(out));
  await rename(tmp, dest);
}

export async function extractTarGz(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const r = spawnSync("tar", ["-xzf", archive, "-C", dest], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`tar extraction failed for ${archive}`);
}

export function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => child.kill(sig));
    }
  });
}

export function log(msg: string): void {
  console.error(`\x1b[36m[ndh]\x1b[0m ${msg}`);
}

export function fail(msg: string): never {
  console.error(`\x1b[31m[ndh]\x1b[0m ${msg}`);
  process.exit(1);
}

export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
