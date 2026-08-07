import { createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";

/**
 * Persistent daily file logging: one file per calendar day (`<prefix>-YYYY-MM-DD.log`, 0600,
 * append), rolled over at midnight even for long-running processes, pruned to the newest
 * `keep` days. Once initialized, `[ndh]` lines (lib.log) and teed child output land here
 * as well as on the console.
 */

let logDir: string | null = null;
let logPrefix = "ndh";
let keepDays = 14;
let stream: WriteStream | null = null;
let currentDay: string | null = null;
let currentPath: string | null = null;

// Clock seam: tests override this to drive the midnight rollover deterministically.
let nowFn: () => Date = () => new Date();

function today(): string {
  return nowFn().toISOString().slice(0, 10);
}

function openForToday(): void {
  const day = today();
  if (!logDir || day === currentDay) return;
  stream?.end();
  currentDay = day;
  currentPath = join(logDir, `${logPrefix}-${day}.log`);
  stream = createWriteStream(currentPath, { flags: "a", mode: 0o600 });
  const files = readdirSync(logDir)
    .filter((f) => f.startsWith(`${logPrefix}-`) && f.endsWith(".log"))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keepDays))) {
    rmSync(join(logDir, f), { force: true });
  }
}

export function initFileLog(dir: string, prefix: string, keep = 14): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  logDir = dir;
  logPrefix = prefix;
  keepDays = keep;
  currentDay = null;
  openForToday();
  return currentPath!;
}

export function fileLogActive(): boolean {
  return logDir !== null;
}

/** Raw chunk tee (child stdout/stderr). ANSI escapes are stripped so files stay greppable. */
export function fileLogWrite(chunk: string | Buffer): void {
  if (!logDir) return;
  openForToday();
  // eslint-disable-next-line no-control-regex
  stream!.write(chunk.toString().replace(/\x1b\[[0-9;]*m/g, ""));
}

export function fileLogLine(line: string): void {
  if (!logDir) return;
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  fileLogWrite(`${new Date().toISOString()} ${plain}${plain.endsWith("\n") ? "" : "\n"}`);
}

export function fileLogPath(): string | null {
  return currentPath;
}

/** Test-only seams: inject the clock and reset the module singleton between cases. */
export const __test = {
  setNow(fn: (() => Date) | null): void {
    nowFn = fn ?? (() => new Date());
  },
  reset(): void {
    stream?.end();
    logDir = null;
    logPrefix = "ndh";
    keepDays = 14;
    stream = null;
    currentDay = null;
    currentPath = null;
    nowFn = () => new Date();
  },
};
