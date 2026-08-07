import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  clearJobAlias,
  deletePlaceholder,
  deletePlaceholders,
  frontStateDbPath,
  isValidSlug,
  listJobAliases,
  listPlaceholders,
  placeholderFromBody,
  readJsonBody,
  serveJobAliasCrud,
  servePlaceholderCrud,
  setJobAlias,
  upsertPlaceholder,
  type ProjectPlaceholder,
} from "../frontstore.js";
import { freshHome, startServer, type Fixture } from "./helpers.js";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "ndh-fs-")), "frontstate.db");
}

function ph(slug: string, extra: Partial<ProjectPlaceholder> = {}): ProjectPlaceholder {
  return {
    slug,
    workflowFileName: "ci.yml",
    workflowName: "CI",
    events: ["push"],
    branches: ["main"],
    runsOn: ["self-hosted"],
    createdAt: 1000,
    ...extra,
  };
}

// ── slug + body validation ───────────────────────────────────────────────────
test("isValidSlug: owner/repo only — no extra slashes, spaces, or missing halves", () => {
  assert.ok(isValidSlug("acme/app"));
  assert.ok(isValidSlug("local/my-dir"));
  assert.ok(!isValidSlug("acme"));
  assert.ok(!isValidSlug("acme/"));
  assert.ok(!isValidSlug("/app"));
  assert.ok(!isValidSlug("a/b/c"));
  assert.ok(!isValidSlug("a b/c"));
  assert.ok(!isValidSlug(42));
  assert.ok(!isValidSlug(null));
});

test("placeholderFromBody: normalizes a valid body and rejects bad slugs/shapes", () => {
  const p = placeholderFromBody(
    { slug: "acme/app", workflowName: "CI", events: ["push", 7], branches: "main", runsOn: ["x"] },
    () => 42,
  );
  assert.ok(p);
  assert.equal(p.slug, "acme/app");
  assert.equal(p.workflowName, "CI");
  assert.equal(p.workflowFileName, null);
  assert.deepEqual(p.events, ["push"]); // non-strings dropped
  assert.deepEqual(p.branches, []); // non-array becomes empty, never a crash
  assert.equal(p.createdAt, 42);
  assert.equal(placeholderFromBody({ slug: "nope" }), null);
  assert.equal(placeholderFromBody(null), null);
  assert.equal(placeholderFromBody("str"), null);
});

// ── store CRUD ───────────────────────────────────────────────────────────────
test("frontstore: upsert + list roundtrip, last write wins per slug", async () => {
  const db = tempDb();
  await upsertPlaceholder(ph("acme/app"), db);
  await upsertPlaceholder(ph("acme/two", { createdAt: 2000 }), db);
  await upsertPlaceholder(ph("acme/app", { workflowName: "CI v2", createdAt: 3000 }), db);
  const rows = await listPlaceholders(db);
  assert.deepEqual(rows.map((r) => r.slug), ["acme/two", "acme/app"]); // ordered by created_at
  const app = rows.find((r) => r.slug === "acme/app")!;
  assert.equal(app.workflowName, "CI v2"); // upsert replaced, not duplicated
  assert.deepEqual(app.events, ["push"]);
  assert.deepEqual(app.branches, ["main"]);
  assert.deepEqual(app.runsOn, ["self-hosted"]);
});

test("frontstore: delete removes one row and reports whether it existed", async () => {
  const db = tempDb();
  await upsertPlaceholder(ph("acme/app"), db);
  assert.equal(await deletePlaceholder("acme/app", db), true);
  assert.equal(await deletePlaceholder("acme/app", db), false); // idempotent
  assert.deepEqual(await listPlaceholders(db), []);
});

test("frontstore: bulk delete prunes absorbed slugs; unreadable store lists as empty", async () => {
  const db = tempDb();
  await upsertPlaceholder(ph("a/b"), db);
  await upsertPlaceholder(ph("c/d"), db);
  await deletePlaceholders(["a/b", "c/d", "not/there"], db);
  assert.deepEqual(await listPlaceholders(db), []);
  await deletePlaceholders([], db); // no-op path
  // A directory path can't be opened as a DB — tolerant read.
  assert.deepEqual(await listPlaceholders(join(tmpdir(), "definitely-missing-dir-x", "nope.db")), []);
});

test("frontStateDbPath lives under NDH_HOME/hub", () => {
  const home = freshHome();
  assert.equal(frontStateDbPath(), join(home, "hub", "frontstate.db"));
});

// ── HTTP CRUD handler ───────────────────────────────────────────────────────
async function crudServer(dbPath: string): Promise<Fixture> {
  return startServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    void servePlaceholderCrud(req, url, res, dbPath);
  });
}

function req(
  port: number,
  path: string,
  method = "GET",
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json" } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}

test("placeholder CRUD route: POST creates, GET lists, DELETE removes", async () => {
  const db = tempDb();
  const s = await crudServer(db);
  try {
    const post = await req(s.port, "/api/local/projects/placeholder", "POST", JSON.stringify({ slug: "acme/app", events: ["push"] }));
    assert.equal(post.status, 200);
    assert.equal(JSON.parse(post.body).ok, true);

    const list = await req(s.port, "/api/local/projects/placeholder");
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.body)[0].slug, "acme/app");

    const del = await req(s.port, "/api/local/projects/placeholder?slug=acme%2Fapp", "DELETE");
    assert.equal(del.status, 200);
    assert.equal(JSON.parse(del.body).removed, true);
    assert.deepEqual(await listPlaceholders(db), []);
  } finally {
    await s.close();
  }
});

test("placeholder CRUD route: bad slug, bad JSON, missing DELETE slug, wrong method", async () => {
  const s = await crudServer(tempDb());
  try {
    const badSlug = await req(s.port, "/api/local/projects/placeholder", "POST", JSON.stringify({ slug: "oneword" }));
    assert.equal(badSlug.status, 400);
    const badJson = await req(s.port, "/api/local/projects/placeholder", "POST", "{nope");
    assert.equal(badJson.status, 400);
    const noSlug = await req(s.port, "/api/local/projects/placeholder", "DELETE");
    assert.equal(noSlug.status, 400);
    const put = await req(s.port, "/api/local/projects/placeholder", "PUT");
    assert.equal(put.status, 405);
  } finally {
    await s.close();
  }
});

test("readJsonBody: rejects oversized bodies", async () => {
  const s = await startServer(async (rq, res) => {
    try {
      await readJsonBody(rq, 8);
      res.writeHead(200);
    } catch (err) {
      res.writeHead(413);
      res.write(String((err as Error).message));
    }
    res.end();
  });
  try {
    const r = await req(s.port, "/", "POST", JSON.stringify({ big: "x".repeat(100) }));
    assert.equal(r.status, 413);
    assert.match(r.body, /body too large/);
  } finally {
    await s.close();
  }
});

// ── #114 job display aliases ────────────────────────────────────────────────
test("job aliases: set + list (scoped and all) + replace + clear — original identity untouched", async () => {
  const db = tempDb();
  await setJobAlias("acme/app", "build", "  Compile  ", db, () => 5);
  await setJobAlias("acme/app", "test", "Unit tests", db, () => 6);
  await setJobAlias("other/x", "build", "B", db, () => 7);

  const scoped = await listJobAliases("acme/app", db);
  assert.deepEqual(scoped.map((a) => `${a.jobKey}=${a.alias}`), ["build=Compile", "test=Unit tests"]); // trimmed
  assert.equal((await listJobAliases(undefined, db)).length, 3);

  // Replace, not duplicate: the key is (project, job_key).
  await setJobAlias("acme/app", "build", "Compile v2", db, () => 8);
  assert.equal((await listJobAliases("acme/app", db)).find((a) => a.jobKey === "build")?.alias, "Compile v2");

  assert.equal(await clearJobAlias("acme/app", "build", db), true);
  assert.equal(await clearJobAlias("acme/app", "build", db), false); // idempotent
  assert.deepEqual((await listJobAliases("acme/app", db)).map((a) => a.jobKey), ["test"]);
  // Tolerant read on an unreadable store: no aliases, never an error.
  assert.deepEqual(await listJobAliases(undefined, join(tmpdir(), "missing-dir-xyz", "no.db")), []);
});

async function aliasServer(dbPath: string): Promise<Fixture> {
  return startServer((rq, res) => {
    const url = new URL(rq.url ?? "/", "http://x");
    void serveJobAliasCrud(rq, url, res, dbPath);
  });
}

test("alias CRUD route: POST sets, GET lists (project-scoped), DELETE clears", async () => {
  const db = tempDb();
  const s = await aliasServer(db);
  try {
    const post = await req(s.port, "/api/local/job-aliases", "POST", JSON.stringify({ project: "acme/app", jobKey: "build", alias: "Compile" }));
    assert.equal(post.status, 200);

    const list = await req(s.port, "/api/local/job-aliases?project=acme%2Fapp");
    assert.deepEqual(JSON.parse(list.body).map((a: { alias: string }) => a.alias), ["Compile"]);

    const del = await req(s.port, "/api/local/job-aliases?project=acme%2Fapp&jobKey=build", "DELETE");
    assert.equal(JSON.parse(del.body).removed, true);
    assert.deepEqual(await listJobAliases("acme/app", db), []);
  } finally {
    await s.close();
  }
});

test("alias CRUD route: rejects bad project, empty alias/jobKey, bad JSON, wrong method", async () => {
  const s = await aliasServer(tempDb());
  try {
    assert.equal((await req(s.port, "/api/local/job-aliases", "POST", JSON.stringify({ project: "nope", jobKey: "b", alias: "x" }))).status, 400);
    assert.equal((await req(s.port, "/api/local/job-aliases", "POST", JSON.stringify({ project: "a/b", jobKey: "b", alias: "   " }))).status, 400);
    assert.equal((await req(s.port, "/api/local/job-aliases", "POST", JSON.stringify({ project: "a/b", alias: "x" }))).status, 400);
    assert.equal((await req(s.port, "/api/local/job-aliases", "POST", "{broken")).status, 400);
    assert.equal((await req(s.port, "/api/local/job-aliases?project=a%2Fb", "DELETE")).status, 400); // no jobKey
    assert.equal((await req(s.port, "/api/local/job-aliases", "PUT")).status, 405);
  } finally {
    await s.close();
  }
});
