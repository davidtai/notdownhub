import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ndhHome } from "./lib.js";

/*
  Front-owned durable UI state (NDH_HOME/hub/frontstate.db).

  The engine has no project registry by design, and we never write its database.
  State the FRONT owns — like the #113 "planned project" placeholders a user
  creates before the first run — lives here, in a SQLite file of our own,
  following the joblogs.db pattern (node:sqlite, WAL, 0600).

  Why a separate file and not a table inside joblogs.db: joblogs.db is a
  high-churn log store with retention pruning and per-run purges; this state is
  tiny, must survive indefinitely, and must never sit in the blast radius of log
  retention. Same open pattern, separate lifecycle.

  A placeholder is keyed by its project slug (owner/repo). It exists only until
  a real run with the same slug appears — the merge in projects.ts absorbs it
  (the real row takes over) and prunes the placeholder row.
*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any; // node:sqlite DatabaseSync — typed loosely; the module is experimental.

/** Path to the front-state database for the current NDH_HOME. */
export function frontStateDbPath(): string {
  return join(ndhHome(), "hub", "frontstate.db");
}

/** Open (and, when writable, initialize) the front-state database. */
export async function openFrontDb(path = frontStateDbPath(), readOnly = false): Promise<Db> {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { readOnly });
  db.exec("PRAGMA busy_timeout=2000");
  if (!readOnly) {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(
      `CREATE TABLE IF NOT EXISTS project_placeholders (
         slug TEXT PRIMARY KEY,
         workflow_file_name TEXT,
         workflow_name TEXT,
         events TEXT NOT NULL DEFAULT '[]',
         branches TEXT NOT NULL DEFAULT '[]',
         runs_on TEXT NOT NULL DEFAULT '[]',
         created_at INTEGER NOT NULL
       )`,
    );
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
  }
  return db;
}

/** A planned project the operator registered before its first run (#113). */
export interface ProjectPlaceholder {
  /** Project slug, `owner/repo` — the identity a future run must match to absorb this row. */
  slug: string;
  /** Bare file name of the workflow YAML the wizard parsed, when known. */
  workflowFileName: string | null;
  /** The workflow's declared `name:`, when present. */
  workflowName: string | null;
  /** Event names from the parsed `on:` block. */
  events: string[];
  /** Branch include-filters from the parsed `on:` block. */
  branches: string[];
  /** Distinct `runs-on` labels across the workflow's jobs. */
  runsOn: string[];
  /** Creation time, epoch ms. */
  createdAt: number;
}

/**
 * A valid project slug is exactly `owner/repo`: two non-empty, slash-free,
 * whitespace-free halves. The engine records the value verbatim and derives the
 * owner by splitting on "/", so anything else would render as Unknown/Unknown.
 */
export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && /^[^/\s]+\/[^/\s]+$/.test(slug);
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function fromJsonArray(raw: unknown): string[] {
  try {
    return toStringArray(JSON.parse(String(raw ?? "[]")));
  } catch {
    return [];
  }
}

/** Normalize an untrusted request body into a placeholder, or null when it has no valid slug. */
export function placeholderFromBody(body: unknown, now = Date.now): ProjectPlaceholder | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (!isValidSlug(o.slug)) return null;
  return {
    slug: o.slug,
    workflowFileName: typeof o.workflowFileName === "string" ? o.workflowFileName : null,
    workflowName: typeof o.workflowName === "string" ? o.workflowName : null,
    events: toStringArray(o.events),
    branches: toStringArray(o.branches),
    runsOn: toStringArray(o.runsOn),
    createdAt: now(),
  };
}

/** Create or replace the placeholder for a slug (the wizard re-run wins — last write is the truth). */
export async function upsertPlaceholder(p: ProjectPlaceholder, dbPath = frontStateDbPath()): Promise<void> {
  const db = await openFrontDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO project_placeholders(slug,workflow_file_name,workflow_name,events,branches,runs_on,created_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET
         workflow_file_name=excluded.workflow_file_name,
         workflow_name=excluded.workflow_name,
         events=excluded.events,
         branches=excluded.branches,
         runs_on=excluded.runs_on,
         created_at=excluded.created_at`,
    ).run(
      p.slug,
      p.workflowFileName,
      p.workflowName,
      JSON.stringify(p.events),
      JSON.stringify(p.branches),
      JSON.stringify(p.runsOn),
      p.createdAt,
    );
  } finally {
    db.close();
  }
}

/**
 * Every stored placeholder, oldest first. Tolerant: an unreadable or absent
 * database means "no placeholders", never an error the caller must handle —
 * the Projects surface must keep working on a hub that never created one.
 */
export async function listPlaceholders(dbPath = frontStateDbPath()): Promise<ProjectPlaceholder[]> {
  try {
    const db = await openFrontDb(dbPath, true);
    try {
      const rows = db
        .prepare(
          `SELECT slug, workflow_file_name AS f, workflow_name AS n, events, branches, runs_on AS r, created_at AS c
           FROM project_placeholders ORDER BY created_at, slug`,
        )
        .all() as { slug: string; f: string | null; n: string | null; events: string; branches: string; r: string; c: number }[];
      return rows.map((row) => ({
        slug: row.slug,
        workflowFileName: row.f,
        workflowName: row.n,
        events: fromJsonArray(row.events),
        branches: fromJsonArray(row.branches),
        runsOn: fromJsonArray(row.r),
        createdAt: row.c,
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Delete one placeholder. Returns whether a row was removed (idempotent). */
export async function deletePlaceholder(slug: string, dbPath = frontStateDbPath()): Promise<boolean> {
  const db = await openFrontDb(dbPath);
  try {
    const info = db.prepare("DELETE FROM project_placeholders WHERE slug=?").run(slug);
    return Number(info.changes ?? 0) > 0;
  } finally {
    db.close();
  }
}

/** Delete several placeholders (absorption prune). Best effort: swallows store errors. */
export async function deletePlaceholders(slugs: string[], dbPath = frontStateDbPath()): Promise<void> {
  if (slugs.length === 0) return;
  try {
    const db = await openFrontDb(dbPath);
    try {
      const del = db.prepare("DELETE FROM project_placeholders WHERE slug=?");
      for (const slug of slugs) del.run(slug);
    } finally {
      db.close();
    }
  } catch {
    /* pruning is cosmetic — the merge already hid the absorbed row */
  }
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

const JSON_HEADERS = { "content-type": "application/json" } as const;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * Read a small JSON request body (cap 256 KB — a placeholder is a few hundred
 * bytes). An oversized body is rejected but still drained, so the caller can
 * answer with a clean 4xx instead of resetting the socket mid-request.
 */
export function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (tooBig) return; // keep draining, stop accumulating
      size += c.length;
      if (size > maxBytes) {
        tooBig = true;
        chunks.length = 0;
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * /api/local/projects/placeholder — CRUD for planned-project placeholders (#113).
 * Gated by the caller (front.ts) like every other /api/local surface:
 *   GET     → the stored placeholders
 *   POST    → create/replace one ({ slug, workflowFileName?, workflowName?, events?, branches?, runsOn? })
 *   DELETE  → remove one (?slug=owner/repo)
 */
export async function servePlaceholderCrud(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  dbPath = frontStateDbPath(),
): Promise<void> {
  try {
    if (req.method === "GET") {
      json(res, 200, await listPlaceholders(dbPath));
      return;
    }
    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        json(res, 400, { ok: false, error: String((err as Error).message ?? err) });
        return;
      }
      const placeholder = placeholderFromBody(body);
      if (!placeholder) {
        json(res, 400, { ok: false, error: "slug must be owner/repo" });
        return;
      }
      await upsertPlaceholder(placeholder, dbPath);
      json(res, 200, { ok: true, placeholder });
      return;
    }
    if (req.method === "DELETE") {
      const slug = url.searchParams.get("slug");
      if (!isValidSlug(slug)) {
        json(res, 400, { ok: false, error: "missing or invalid ?slug=owner/repo" });
        return;
      }
      json(res, 200, { ok: true, slug, removed: await deletePlaceholder(slug, dbPath) });
      return;
    }
    res.writeHead(405, { ...JSON_HEADERS, allow: "GET, POST, DELETE" });
    res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
  } catch (err) {
    json(res, 500, { ok: false, error: String(err) });
  }
}
