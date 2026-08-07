import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initFileLog,
  fileLogActive,
  fileLogWrite,
  fileLogLine,
  fileLogPath,
  __test as fl,
} from "../filelog.js";

afterEach(() => fl.reset());

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ndh-fl-"));
}

// createWriteStream opens the fd asynchronously; give it a tick so the file + buffered writes land.
const flush = () => new Promise((r) => setTimeout(r, 60));

test("initFileLog creates a 0600 dated file and reports active state", async () => {
  const dir = tmp();
  fl.setNow(() => new Date("2024-03-09T10:00:00Z"));
  const path = initFileLog(join(dir, "logs"), "hub");
  assert.ok(path.endsWith("hub-2024-03-09.log"));
  assert.equal(fileLogActive(), true);
  assert.equal(fileLogPath(), path);
  await flush();
  assert.equal(existsSync(path), true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("fileLogWrite strips ANSI; fileLogLine adds an ISO timestamp and a trailing newline", async () => {
  const dir = tmp();
  fl.setNow(() => new Date("2024-03-09T10:00:00Z"));
  const path = initFileLog(join(dir, "logs"), "run");
  fileLogWrite("\x1b[36mcolored\x1b[0m chunk");
  fileLogLine("\x1b[31mline-without-newline\x1b[0m");
  fileLogLine("line-with-newline\n");
  await flush();
  const out = readFileSync(path, "utf8");
  assert.ok(!out.includes("\x1b["), "ANSI stripped");
  assert.match(out, /^colored chunk/); // raw chunk, ANSI stripped, no newline auto-added
  assert.match(out, /\d{4}-\d\d-\d\dT[\d:.]+Z line-without-newline\n/);
  assert.match(out, /\d{4}-\d\d-\d\dT[\d:.]+Z line-with-newline\n/);
});

test("inactive log: write/line are no-ops and path is null", () => {
  fl.reset();
  assert.equal(fileLogActive(), false);
  assert.equal(fileLogPath(), null);
  assert.doesNotThrow(() => fileLogWrite("ignored"));
  assert.doesNotThrow(() => fileLogLine("ignored"));
});

test("midnight rollover opens a new dated file", async () => {
  const dir = join(tmp(), "logs");
  let day = "2024-03-09T23:59:00Z";
  fl.setNow(() => new Date(day));
  const first = initFileLog(dir, "hub");
  fileLogLine("before midnight");
  await flush();
  day = "2024-03-10T00:01:00Z";
  fileLogLine("after midnight"); // triggers openForToday rollover
  await flush();
  const second = fileLogPath()!;
  assert.notEqual(first, second);
  assert.ok(second.endsWith("hub-2024-03-10.log"));
  assert.match(readFileSync(first, "utf8"), /before midnight/);
  assert.match(readFileSync(second, "utf8"), /after midnight/);
});

test("prune keeps only the newest `keep` days", async () => {
  const dir = join(tmp(), "logs");
  mkdirSync(dir, { recursive: true });
  // pre-create four days INCLUDING today so the (synchronous) prune sees all of them
  for (const d of ["2000-01-01", "2000-01-02", "2000-01-03", "2000-01-04"]) {
    writeFileSync(join(dir, `hub-${d}.log`), "old");
  }
  // an unrelated file must survive (different prefix)
  writeFileSync(join(dir, "other-2000-01-01.log"), "keep-me");
  fl.setNow(() => new Date("2000-01-04T00:00:00Z"));
  initFileLog(dir, "hub", 2); // keep newest 2 of the four hub-*.log files
  await flush();
  const remaining = readdirSync(dir).sort();
  assert.deepEqual(
    remaining.filter((f) => f.startsWith("hub-")),
    ["hub-2000-01-03.log", "hub-2000-01-04.log"],
  );
  assert.ok(remaining.includes("other-2000-01-01.log"), "other prefixes are untouched");
});
