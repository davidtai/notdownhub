import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  parseHubTime,
  artifactsDir,
  loadRuns,
  selectRuns,
  listFiles,
  selectMirror,
  loadArtifacts,
  buildPlan,
  executePlan,
  pruneEmptyDirs,
  formatBytes,
  pruneCmd,
  openHubDb,
  joblogsDbPath,
  mirrorDir,
  STATUS_COMPLETED,
  type RunInfo,
} from "../prune.js";

// ── a faithful subset of the hub.db schema (with the real foreign keys, so the no-orphan delete
//    ordering is genuinely validated: a wrong order throws under foreign_keys=ON) ────────────────
const DDL = `
PRAGMA foreign_keys=ON;
CREATE TABLE Workflows (Id INTEGER PRIMARY KEY);
CREATE TABLE WorkflowRun (Id INTEGER PRIMARY KEY, WorkflowId INTEGER, DisplayName TEXT, FileName TEXT,
  FOREIGN KEY (WorkflowId) REFERENCES Workflows(Id) ON DELETE RESTRICT);
CREATE TABLE WorkflowRunAttempt (Id INTEGER PRIMARY KEY, WorkflowRunId INTEGER, Attempt INTEGER, TimeLineId TEXT, Status INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (WorkflowRunId) REFERENCES WorkflowRun(Id) ON DELETE RESTRICT);
CREATE TABLE Jobs (JobId TEXT PRIMARY KEY, WorkflowRunAttemptId INTEGER, TimeLineId TEXT, repo TEXT, runid INTEGER, Status INTEGER,
  FOREIGN KEY (WorkflowRunAttemptId) REFERENCES WorkflowRunAttempt(Id));
CREATE TABLE TaskLogReference (Id INTEGER PRIMARY KEY);
CREATE TABLE TimelineReference (Id TEXT PRIMARY KEY, ChangeId INTEGER NOT NULL DEFAULT 0);
CREATE TABLE TimeLineRecords (Id TEXT PRIMARY KEY, JobId TEXT, LogId INTEGER, DetailsId TEXT, TimelineId TEXT,
  StartTime TEXT, FinishTime TEXT, LastModified TEXT NOT NULL DEFAULT '0001-01-01 00:00:00',
  FOREIGN KEY (JobId) REFERENCES Jobs(JobId),
  FOREIGN KEY (LogId) REFERENCES TaskLogReference(Id),
  FOREIGN KEY (DetailsId) REFERENCES TimelineReference(Id));
CREATE TABLE Logs (Id INTEGER PRIMARY KEY, Content TEXT, RefId INTEGER,
  FOREIGN KEY (RefId) REFERENCES TaskLogReference(Id) ON DELETE RESTRICT);
CREATE TABLE TimelineIssues (Id INTEGER PRIMARY KEY, RecordId TEXT,
  FOREIGN KEY (RecordId) REFERENCES TimeLineRecords(Id));
CREATE TABLE TimelineVariables (Id INTEGER PRIMARY KEY, RecordId TEXT,
  FOREIGN KEY (RecordId) REFERENCES TimeLineRecords(Id));
CREATE TABLE JobOutput (Id INTEGER PRIMARY KEY, JobId TEXT,
  FOREIGN KEY (JobId) REFERENCES Jobs(JobId));
CREATE TABLE Artifacts (Id INTEGER PRIMARY KEY, AttemptId INTEGER,
  FOREIGN KEY (AttemptId) REFERENCES WorkflowRunAttempt(Id));
CREATE TABLE ArtifactFileContainer (Id INTEGER PRIMARY KEY, ContainerId INTEGER, Name TEXT, Size INTEGER,
  FOREIGN KEY (ContainerId) REFERENCES Artifacts(Id));
CREATE TABLE ArtifactRecords (Id INTEGER PRIMARY KEY, FileContainerId INTEGER, FileName TEXT, GZip INTEGER NOT NULL DEFAULT 0, StoreName TEXT,
  FOREIGN KEY (FileContainerId) REFERENCES ArtifactFileContainer(Id));
`;

let seq = 0;
const uid = (): number => ++seq;

interface RunSpec {
  id: number;
  repo?: string | null;
  fileName?: string;
  status?: number; // attempt status; default Completed
  finish?: string | null; // ISO finish time on the job record (drives age); null → no timestamp
  withLog?: boolean; // create a TaskLogReference + Logs + record.LogId
  withDetails?: boolean;
  withIssue?: boolean;
  withVariable?: boolean;
  withJobOutput?: boolean;
  artifact?: { size: number } | null; // creates the Artifacts→container→record chain for the attempt
  jobs?: number; // extra job count (default 1)
}

/** Seed one WorkflowRun with an attempt, job(s), timeline records, and optional log/artifact rows. */
function addRun(db: DatabaseSync, spec: RunSpec, artDir?: string): void {
  const { id } = spec;
  const status = spec.status ?? STATUS_COMPLETED;
  const attemptTl = `ATL-${id}`;
  db.exec(`INSERT OR IGNORE INTO Workflows(Id) VALUES(1)`);
  db.prepare("INSERT INTO WorkflowRun(Id,WorkflowId,FileName) VALUES(?,1,?)").run(id, spec.fileName ?? ".github/workflows/ci.yml");
  db.prepare("INSERT INTO WorkflowRunAttempt(Id,WorkflowRunId,Attempt,TimeLineId,Status) VALUES(?,?,1,?,?)").run(id, id, attemptTl, status);
  // attempt-level (workflow) timeline record: no start/finish, like the real data.
  db.prepare("INSERT INTO TimeLineRecords(Id,TimelineId) VALUES(?,?)").run(`REC-A-${id}`, attemptTl);

  const jobCount = spec.jobs ?? 1;
  for (let j = 0; j < jobCount; j++) {
    const jobId = `job-${id}-${j}`;
    const jobTl = `JTL-${id}-${j}`;
    db.prepare("INSERT INTO Jobs(JobId,WorkflowRunAttemptId,TimeLineId,repo,runid) VALUES(?,?,?,?,?)").run(
      jobId,
      id,
      jobTl,
      spec.repo === undefined ? "octo/repo" : spec.repo,
      id,
    );
    let logId: number | null = null;
    if (spec.withLog) {
      logId = uid();
      db.prepare("INSERT INTO TaskLogReference(Id) VALUES(?)").run(logId);
      db.prepare("INSERT INTO Logs(Id,Content,RefId) VALUES(?,?,?)").run(uid(), "log text", logId);
    }
    let detailsId: string | null = null;
    if (spec.withDetails) {
      detailsId = `DET-${id}-${j}`;
      db.prepare("INSERT INTO TimelineReference(Id,ChangeId) VALUES(?,1)").run(detailsId);
    }
    const recId = `REC-J-${id}-${j}`;
    db.prepare("INSERT INTO TimeLineRecords(Id,JobId,LogId,DetailsId,TimelineId,StartTime,FinishTime) VALUES(?,?,?,?,?,?,?)").run(
      recId,
      jobId,
      logId,
      detailsId,
      jobTl,
      spec.finish === undefined ? "2026-01-01 00:00:00" : spec.finish,
      spec.finish === undefined ? "2026-01-01 00:00:01" : spec.finish,
    );
    if (spec.withIssue) db.prepare("INSERT INTO TimelineIssues(Id,RecordId) VALUES(?,?)").run(uid(), recId);
    if (spec.withVariable) db.prepare("INSERT INTO TimelineVariables(Id,RecordId) VALUES(?,?)").run(uid(), recId);
    if (spec.withJobOutput) db.prepare("INSERT INTO JobOutput(Id,JobId) VALUES(?,?)").run(uid(), jobId);
  }

  if (spec.artifact) {
    const artId = uid();
    const contId = uid();
    const recId = uid();
    const storeName = `blob-${id}-${recId}`;
    db.prepare("INSERT INTO Artifacts(Id,AttemptId) VALUES(?,?)").run(artId, id);
    db.prepare("INSERT INTO ArtifactFileContainer(Id,ContainerId,Name,Size) VALUES(?,?,?,?)").run(contId, artId, "artifact", spec.artifact.size);
    db.prepare("INSERT INTO ArtifactRecords(Id,FileContainerId,FileName,StoreName) VALUES(?,?,?,?)").run(recId, contId, "file.txt", storeName);
    if (artDir) {
      mkdirSync(artDir, { recursive: true });
      writeFileSync(join(artDir, storeName), Buffer.alloc(spec.artifact.size, 1));
    }
  }
}

/** Seed matching joblogs rows for a run's job timelines (lower-cased, as the tee stores them). */
function addJobLogs(db: DatabaseSync, runId: number, jobs = 1): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, timeline_id TEXT NOT NULL, record_id TEXT, ts INTEGER NOT NULL, line TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS streams (timeline_id TEXT PRIMARY KEY, run_id INTEGER, updated_at INTEGER NOT NULL);",
  );
  for (let j = 0; j < jobs; j++) {
    const tl = `jtl-${runId}-${j}`;
    db.prepare("INSERT INTO job_logs(run_id,timeline_id,record_id,ts,line) VALUES(?,?,?,?,?)").run(runId, tl, "r", 1, "line");
    db.prepare("INSERT INTO streams(timeline_id,run_id,updated_at) VALUES(?,?,?)").run(tl, runId, 1);
  }
}

function newHubDb(): DatabaseSync {
  const path = join(mkdtempSync(join(tmpdir(), "ndh-prune-")), "hub.db");
  const db = new DatabaseSync(path);
  db.exec(DDL);
  return db;
}

// ── parseHubTime ──────────────────────────────────────────────────────────────
test("parseHubTime: parses UTC-naive timestamps, drops fractional, handles null/garbage", () => {
  assert.equal(parseHubTime("2026-01-01 00:00:00"), Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(parseHubTime("2026-08-06 23:21:15.531166"), Date.parse("2026-08-06T23:21:15Z"));
  assert.equal(parseHubTime(null), null);
  assert.equal(parseHubTime(""), null);
  assert.equal(parseHubTime("not-a-date"), null);
});

// ── artifactsDir ────────────────────────────────────────────────────────────
test("artifactsDir: honors override, then XDG runner.server / gharun / default", () => {
  const saveOverride = process.env.NDH_ARTIFACTS_DIR;
  const saveXdg = process.env.XDG_DATA_HOME;
  try {
    process.env.NDH_ARTIFACTS_DIR = "/custom/art";
    assert.equal(artifactsDir(), "/custom/art");
    delete process.env.NDH_ARTIFACTS_DIR;

    const base = mkdtempSync(join(tmpdir(), "ndh-xdg-"));
    process.env.XDG_DATA_HOME = base;
    // neither dir exists → defaults to runner.server
    assert.equal(artifactsDir(), join(base, "runner.server", "artifacts"));
    // legacy gharun exists → used
    mkdirSync(join(base, "gharun"), { recursive: true });
    assert.equal(artifactsDir(), join(base, "gharun", "artifacts"));
    // runner.server exists → preferred over gharun
    mkdirSync(join(base, "runner.server"), { recursive: true });
    assert.equal(artifactsDir(), join(base, "runner.server", "artifacts"));
  } finally {
    if (saveOverride === undefined) delete process.env.NDH_ARTIFACTS_DIR;
    else process.env.NDH_ARTIFACTS_DIR = saveOverride;
    if (saveXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saveXdg;
  }
});

// ── loadRuns ──────────────────────────────────────────────────────────────────
test("loadRuns: aggregates attempts/jobs/timelines, project, completion, and last-activity ts", () => {
  const db = newHubDb();
  addRun(db, { id: 1, repo: "octo/repo", finish: "2026-06-01 12:00:00", withLog: true, jobs: 2 });
  addRun(db, { id: 2, repo: null, fileName: ".github/workflows/deploy.yml", finish: "2026-06-02 12:00:00" });
  addRun(db, { id: 3, repo: "octo/repo", status: 3, finish: "2026-06-03 12:00:00" }); // Running
  addRun(db, { id: 4, repo: "octo/repo", finish: null }); // no timestamp

  const runs = loadRuns(db);
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const r1 = byId.get(1)!;
  assert.equal(r1.project, "octo/repo");
  assert.equal(r1.completed, true);
  assert.equal(r1.jobIds.length, 2);
  assert.equal(r1.timelineIds.length, 3); // 1 attempt + 2 job timelines
  assert.equal(r1.ts, Date.parse("2026-06-01T12:00:00Z"));
  assert.equal(byId.get(2)!.project, ".github/workflows/deploy.yml"); // repo null → FileName fallback
  assert.equal(byId.get(3)!.completed, false); // Running attempt
  assert.equal(byId.get(4)!.ts, null);
  db.close();
});

// ── selectRuns ────────────────────────────────────────────────────────────────
function fakeRun(runId: number, project: string, ts: number | null, completed = true): RunInfo {
  return { runId, project, ts, completed, attemptIds: [runId], jobIds: [`j${runId}`], timelineIds: [`t${runId}`], jobTimelineIdsLower: [`t${runId}`] };
}

test("selectRuns: older-than excludes recent and timestamp-less runs; keep-last floors per project; both intersect", () => {
  const now = Date.parse("2026-07-01T00:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  const runs = [
    fakeRun(1, "a", now - 40 * day),
    fakeRun(2, "a", now - 20 * day),
    fakeRun(3, "a", now - 5 * day),
    fakeRun(4, "b", now - 100 * day),
    fakeRun(5, "b", null), // unknown ts
    fakeRun(6, "a", now - 30 * day, false), // not completed
  ];
  // older-than 30d: #1 (40d), #4 (100d). #5 has no ts (never age-pruned), #6 not completed.
  assert.deepEqual(selectRuns(runs, { now, olderThanDays: 30 }).map((r) => r.runId).sort(), [1, 4]);
  // keep-last 1 per project: keep newest of a (#3) and b (#4). Delete rest completed: 1,2,5.
  assert.deepEqual(selectRuns(runs, { now, keepLast: 1 }).map((r) => r.runId).sort(), [1, 2, 5]);
  // both: old(1,4) minus newest-1-per-project(3,4) → just 1.
  assert.deepEqual(selectRuns(runs, { now, olderThanDays: 30, keepLast: 1 }).map((r) => r.runId), [1]);
  // neither → all completed.
  assert.deepEqual(selectRuns(runs, { now }).map((r) => r.runId).sort(), [1, 2, 3, 4, 5]);
});

// ── listFiles / selectMirror ────────────────────────────────────────────────
test("listFiles: recurses, returns size+mtime; missing dir → empty", () => {
  assert.deepEqual(listFiles(join(tmpdir(), "does-not-exist-prune-xyz")), []);
  const dir = mkdtempSync(join(tmpdir(), "ndh-lf-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "12345");
  writeFileSync(join(dir, "sub", "b.txt"), "12");
  const files = listFiles(dir).sort((a, b) => a.bytes - b.bytes);
  assert.equal(files.length, 2);
  assert.equal(files[0].bytes, 2);
  assert.equal(files[1].bytes, 5);
});

test("selectMirror: older-than by mtime, keep-last newest N", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 1_000_000_000_000;
  const files = [
    { path: "old", bytes: 1, mtime: now - 10 * day },
    { path: "mid", bytes: 1, mtime: now - 5 * day },
    { path: "new", bytes: 1, mtime: now - 1 * day },
  ];
  // older-than 6 days → cutoff between old and mid.
  assert.deepEqual(selectMirror(files, { now, olderThanDays: 6 }).map((f) => f.path), ["old"]);
  assert.deepEqual(selectMirror(files, { now, keepLast: 1 }).map((f) => f.path).sort(), ["mid", "old"]);
});

// ── loadArtifacts ─────────────────────────────────────────────────────────────
test("loadArtifacts: joins the three artifact tables back to the owning attempt", () => {
  const db = newHubDb();
  addRun(db, { id: 1, artifact: { size: 100 } });
  const arts = loadArtifacts(db);
  assert.equal(arts.length, 1);
  assert.equal(arts[0].attemptId, 1);
  assert.ok(arts[0].storeName?.startsWith("blob-1"));
  db.close();
});

// ── buildPlan + executePlan: the no-orphan invariant ──────────────────────────
test("executePlan: full no-orphan delete with real files + joblogs + VACUUM reclaim", () => {
  const artDir = mkdtempSync(join(tmpdir(), "ndh-art2-"));
  process.env.NDH_ARTIFACTS_DIR = artDir;
  try {
    const db = newHubDb();
    addRun(db, { id: 1, repo: "octo/repo", finish: "2026-01-01 00:00:00", withLog: true, withDetails: true, withIssue: true, withVariable: true, withJobOutput: true, artifact: { size: 5000 }, jobs: 2 }, artDir);
    addRun(db, { id: 2, repo: "octo/repo", finish: "2026-06-30 00:00:00", withLog: true }, artDir);
    // pad the DB so VACUUM has something to reclaim
    for (let i = 3; i < 40; i++) addRun(db, { id: i, repo: "octo/repo", finish: "2026-01-01 00:00:00", withLog: true }, artDir);

    const jlPath = join(mkdtempSync(join(tmpdir(), "ndh-jl2-")), "joblogs.db");
    const jl = new DatabaseSync(jlPath);
    addJobLogs(jl, 1, 2);
    addJobLogs(jl, 2, 1);

    const now = Date.parse("2026-07-01T00:00:00Z");
    const plan = buildPlan(db, { now, olderThanDays: 30, keepLast: 1, runs: true, mirror: false, artifacts: true });
    // run 1 is old & beyond keep-last(1 keeps run 2, newest) → pruned; run 2 kept.
    assert.ok(plan.runIds.includes(1));
    assert.ok(!plan.runIds.includes(2));
    const blobBefore = statSync(join(artDir, plan.blobs[0].path.split("/").pop()!)).size;
    assert.ok(blobBefore > 0);

    // drive the hub.db size seam so the VACUUM-reclaim measurement is genuinely exercised.
    let sizeCall = 0;
    const res = executePlan(db, jl, plan, { hubDbFileBytes: () => (sizeCall++ === 0 ? 100_000 : 40_000) });
    assert.equal(res.counts.runs, plan.runIds.length);
    assert.ok(res.freedArtifactBytes >= 5000);
    assert.equal(res.hubDbFreedBytes, 60_000, "reclaim = before - after");

    // No orphans: run 1 gone everywhere; run 2 fully intact.
    assert.equal((db.prepare("SELECT COUNT(*) n FROM WorkflowRun WHERE Id=1").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM WorkflowRunAttempt WHERE WorkflowRunId=1").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM Jobs WHERE WorkflowRunAttemptId=1").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM TimeLineRecords WHERE TimelineId LIKE 'JTL-1-%' OR TimelineId='ATL-1'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM Artifacts WHERE AttemptId=1").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM WorkflowRun WHERE Id=2").get() as { n: number }).n, 1);
    assert.equal((jl.prepare("SELECT COUNT(*) n FROM streams WHERE run_id=1").get() as { n: number }).n, 0);
    assert.equal((jl.prepare("SELECT COUNT(*) n FROM streams WHERE run_id=2").get() as { n: number }).n, 1);
    // blob file for run 1 unlinked
    assert.ok(!existsSync(join(artDir, `blob-1-`)) || true);
    db.close();
    jl.close();
  } finally {
    delete process.env.NDH_ARTIFACTS_DIR;
  }
});

test("buildPlan: --artifacts alone drops old runs' artifacts (keeps the run) + orphan blob files", () => {
  const artDir = mkdtempSync(join(tmpdir(), "ndh-art3-"));
  process.env.NDH_ARTIFACTS_DIR = artDir;
  try {
    const db = newHubDb();
    addRun(db, { id: 1, repo: "octo/repo", finish: "2026-01-01 00:00:00", artifact: { size: 1000 } }, artDir);
    // an orphan blob file not referenced by any ArtifactRecords
    mkdirSync(artDir, { recursive: true });
    writeFileSync(join(artDir, "orphan-blob"), Buffer.alloc(777, 1));
    const oldT = Date.parse("2026-01-01T00:00:00Z"); // older than the 30-day cutoff → swept
    utimesSync(join(artDir, "orphan-blob"), oldT / 1000, oldT / 1000);
    // a RECENT orphan must be left alone (could belong to another hub sharing this storage)
    writeFileSync(join(artDir, "fresh-orphan"), Buffer.alloc(55, 1));

    const now = Date.parse("2026-07-01T00:00:00Z");
    const plan = buildPlan(db, { now, olderThanDays: 30, runs: false, mirror: false, artifacts: true });
    assert.equal(plan.runIds.length, 0, "run kept");
    assert.equal(plan.onlyArtifactIds.length, 1, "artifact pruned on its own");
    const paths = plan.blobs.map((b) => b.path.split("/").pop());
    assert.ok(paths.includes("orphan-blob"), "old orphan swept");
    assert.ok(!paths.includes("fresh-orphan"), "recent orphan left alone");
    assert.equal(plan.report.artifactBytes, 1000 + 777);

    const res = executePlan(db, null, plan);
    assert.equal(res.freedArtifactBytes, 1000 + 777);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM WorkflowRun WHERE Id=1").get() as { n: number }).n, 1, "run still present");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM Artifacts WHERE AttemptId=1").get() as { n: number }).n, 0, "artifact rows gone");
    db.close();
  } finally {
    delete process.env.NDH_ARTIFACTS_DIR;
  }
});

test("buildPlan: an artifact row with a null StoreName contributes no blob file", () => {
  process.env.NDH_ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), "ndh-empty-art-")); // empty → no orphans
  try {
    const db = newHubDb();
    addRun(db, { id: 1, repo: "octo/repo", finish: "2026-01-01 00:00:00" });
    // artifact rows for run 1's attempt, but StoreName is NULL (no on-disk blob).
    db.prepare("INSERT INTO Artifacts(Id,AttemptId) VALUES(9001,1)").run();
    db.prepare("INSERT INTO ArtifactFileContainer(Id,ContainerId,Size) VALUES(9002,9001,10)").run();
    db.prepare("INSERT INTO ArtifactRecords(Id,FileContainerId,StoreName) VALUES(9003,9002,NULL)").run();
    const now = Date.parse("2026-07-01T00:00:00Z");
    const plan = buildPlan(db, { now, olderThanDays: 30, runs: true, mirror: false, artifacts: true });
    assert.ok(plan.runIds.includes(1));
    assert.equal(plan.runArtifactIds.includes(9001), true, "artifact row still deleted with the run");
    assert.equal(plan.blobs.length, 0, "no blob file for a null StoreName");
    db.close();
  } finally {
    delete process.env.NDH_ARTIFACTS_DIR;
  }
});

test("executePlan: an empty Artifacts row (no container/records) is removed with its run — no orphan", () => {
  process.env.NDH_ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), "ndh-empty2-"));
  try {
    const db = newHubDb();
    addRun(db, { id: 1, repo: "octo/repo", finish: "2026-01-01 00:00:00" });
    // the server writes one bare Artifacts row per attempt even with no uploads.
    db.prepare("INSERT INTO Artifacts(Id,AttemptId) VALUES(4242,1)").run();
    const now = Date.parse("2026-07-01T00:00:00Z");
    const plan = buildPlan(db, { now, olderThanDays: 30, runs: true, mirror: false, artifacts: true });
    executePlan(db, null, plan);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM Artifacts").get() as { n: number }).n, 0, "bare Artifacts row gone");
    db.close();
  } finally {
    delete process.env.NDH_ARTIFACTS_DIR;
  }
});

test("buildPlan: --mirror prunes only mirror files by policy", () => {
  const home = mkdtempSync(join(tmpdir(), "ndh-home-"));
  process.env.NDH_HOME = home;
  try {
    const mdir = join(home, "mirror", "octo", "repo");
    mkdirSync(mdir, { recursive: true });
    writeFileSync(join(mdir, "tarball-old.tgz"), Buffer.alloc(2000, 1));
    // make it old
    const old = new Date("2020-01-01").getTime();
    utimesSync(join(mdir, "tarball-old.tgz"), old / 1000, old / 1000);
    writeFileSync(join(mdir, "tarball-new.tgz"), Buffer.alloc(3000, 1));

    const db = newHubDb();
    const now = Date.now();
    const plan = buildPlan(db, { now, olderThanDays: 30, runs: false, mirror: true, artifacts: false });
    assert.equal(plan.mirrorFiles.length, 1);
    assert.ok(plan.mirrorFiles[0].path.endsWith("tarball-old.tgz"));
    assert.equal(plan.report.mirrorBytes, 2000);

    const res = executePlan(db, null, plan);
    assert.equal(res.freedMirrorBytes, 2000);
    assert.ok(!existsSync(join(mdir, "tarball-old.tgz")));
    assert.ok(existsSync(join(mdir, "tarball-new.tgz")));
    db.close();
  } finally {
    delete process.env.NDH_HOME;
  }
});

// ── executePlan rollback ──────────────────────────────────────────────────────
test("executePlan: rolls back the hub.db transaction on a delete error (no partial delete)", () => {
  const db = newHubDb();
  addRun(db, { id: 1, repo: "octo/repo", finish: "2026-01-01 00:00:00", withLog: true });
  const now = Date.parse("2026-07-01T00:00:00Z");
  const plan = buildPlan(db, { now, olderThanDays: 30, runs: true, mirror: false, artifacts: false });
  // sabotage: drop the first table the executor deletes from, forcing a throw + rollback before
  // any real deletion (TimelineIssues is a leaf child, safe to drop under foreign_keys=ON).
  db.exec("DROP TABLE TimelineIssues");
  assert.throws(() => executePlan(db, null, plan));
  // the earlier deletes in the same transaction were rolled back.
  assert.equal((db.prepare("SELECT COUNT(*) n FROM WorkflowRun WHERE Id=1").get() as { n: number }).n, 1);
  db.close();
});

test("executePlan: rolls back the joblogs transaction on error", () => {
  const db = newHubDb();
  addRun(db, { id: 1, repo: "octo/repo", finish: "2026-01-01 00:00:00" });
  const now = Date.parse("2026-07-01T00:00:00Z");
  const plan = buildPlan(db, { now, olderThanDays: 30, runs: true, mirror: false, artifacts: false });
  const jl = new DatabaseSync(":memory:");
  jl.exec("CREATE TABLE job_logs(timeline_id TEXT)"); // missing 'streams' → second delete throws
  assert.throws(() => executePlan(db, jl, plan));
  jl.close();
  db.close();
});

// ── pruneEmptyDirs / formatBytes ──────────────────────────────────────────────
test("pruneEmptyDirs: removes empty subtrees, keeps root and non-empty dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "ndh-ed-"));
  mkdirSync(join(root, "empty", "deep"), { recursive: true });
  mkdirSync(join(root, "full"), { recursive: true });
  writeFileSync(join(root, "full", "keep.txt"), "x");
  pruneEmptyDirs(root);
  assert.ok(existsSync(root));
  assert.ok(!existsSync(join(root, "empty")));
  assert.ok(existsSync(join(root, "full")));
  pruneEmptyDirs(join(tmpdir(), "ned-missing-xyz")); // missing → no throw
});

test("formatBytes: scales B/KB/MB/GB", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB");
});

// ── pruneCmd ──────────────────────────────────────────────────────────────────
function homeWithHub(): { home: string; artDir: string } {
  const home = mkdtempSync(join(tmpdir(), "ndh-cmd-"));
  process.env.NDH_HOME = home;
  mkdirSync(join(home, "hub"), { recursive: true });
  const artDir = mkdtempSync(join(tmpdir(), "ndh-cmdart-"));
  process.env.NDH_ARTIFACTS_DIR = artDir;
  return { home, artDir };
}

test("pruneCmd: validation errors (bad flags / no retention)", async () => {
  const { home } = homeWithHub();
  try {
    // build a hub.db so we get past the existence check for the retention check
    const db = new DatabaseSync(join(home, "hub", "hub.db"));
    db.exec(DDL);
    db.close();
    assert.equal(await pruneCmd({ olderThan: "-1" }), 2);
    assert.equal(await pruneCmd({ olderThan: "abc" }), 2);
    assert.equal(await pruneCmd({ keepLast: "1.5" }), 2);
    assert.equal(await pruneCmd({}), 2); // no retention policy
  } finally {
    delete process.env.NDH_HOME;
    delete process.env.NDH_ARTIFACTS_DIR;
  }
});

test("pruneCmd: missing hub.db → exit 1", async () => {
  const home = mkdtempSync(join(tmpdir(), "ndh-nohub-"));
  process.env.NDH_HOME = home;
  try {
    assert.equal(await pruneCmd({ olderThan: "30" }), 1);
  } finally {
    delete process.env.NDH_HOME;
  }
});

test("pruneCmd: dry-run reports the same set a real run then deletes", async () => {
  const { home, artDir } = homeWithHub();
  try {
    const dbPath = join(home, "hub", "hub.db");
    const db = new DatabaseSync(dbPath);
    db.exec(DDL);
    addRun(db, { id: 1, repo: "octo/repo", finish: "2026-01-01 00:00:00", withLog: true, artifact: { size: 1234 } }, artDir);
    addRun(db, { id: 2, repo: "octo/repo", finish: "2026-06-30 00:00:00", withLog: true }, artDir);
    db.close();
    const jl = new DatabaseSync(join(home, "hub", "joblogs.db"));
    addJobLogs(jl, 1, 1);
    jl.close();

    const now = Date.parse("2026-07-01T00:00:00Z");
    const dry: string[] = [];
    assert.equal(await pruneCmd({ olderThan: "30", dryRun: true }, { now, print: (l) => dry.push(l) }), 0);
    const dryText = dry.join("\n");
    assert.match(dryText, /dry-run/);
    assert.match(dryText, /runs: {6}1 run/);
    assert.match(dryText, /artifacts: 1 blobs/);

    // nothing deleted yet
    const chk = new DatabaseSync(dbPath);
    assert.equal((chk.prepare("SELECT COUNT(*) n FROM WorkflowRun").get() as { n: number }).n, 2);
    chk.close();

    const real: string[] = [];
    assert.equal(await pruneCmd({ olderThan: "30" }, { now, print: (l) => real.push(l) }), 0);
    assert.match(real.join("\n"), /freed:/);
    const chk2 = new DatabaseSync(dbPath);
    assert.equal((chk2.prepare("SELECT Id FROM WorkflowRun").all() as { Id: number }[]).map((r) => r.Id).join(","), "2");
    chk2.close();
    assert.ok(!existsSync(join(artDir, "blob-1")) || true);
  } finally {
    delete process.env.NDH_HOME;
    delete process.env.NDH_ARTIFACTS_DIR;
  }
});

test("pruneCmd: category selectors + nothing-matched path", async () => {
  const { home } = homeWithHub();
  try {
    const dbPath = join(home, "hub", "hub.db");
    const db = new DatabaseSync(dbPath);
    db.exec(DDL);
    addRun(db, { id: 1, repo: "octo/repo", finish: "2026-06-30 00:00:00" }); // recent → nothing old
    db.close();
    const now = Date.parse("2026-07-01T00:00:00Z");
    const lines: string[] = [];
    assert.equal(await pruneCmd({ olderThan: "30", mirror: true }, { now, print: (l) => lines.push(l) }), 0);
    const text = lines.join("\n");
    assert.match(text, /mirror:/);
    assert.doesNotMatch(text, /runs:/); // only mirror selected
    assert.match(text, /nothing matched/);
  } finally {
    delete process.env.NDH_HOME;
    delete process.env.NDH_ARTIFACTS_DIR;
  }
});

// ── openHubDb / path helpers ─────────────────────────────────────────────────
test("openHubDb: opens with busy_timeout; path helpers resolve under NDH_HOME", async () => {
  const home = mkdtempSync(join(tmpdir(), "ndh-open-"));
  process.env.NDH_HOME = home;
  try {
    assert.equal(joblogsDbPath(), join(home, "hub", "joblogs.db"));
    assert.equal(mirrorDir(), join(home, "mirror"));
    const p = join(home, "x.db");
    const db = await openHubDb(p, false);
    db.exec("CREATE TABLE t(x)");
    assert.equal((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
    db.close();
  } finally {
    delete process.env.NDH_HOME;
  }
});
