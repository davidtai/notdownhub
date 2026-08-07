import type { IncomingMessage, ServerResponse } from "node:http";
import { backendName, setSecret, removeSecret, validEnvName, GLOBAL_SCOPE } from "./secrets.js";
import { setVar, removeVar } from "./vars.js";
import { readJsonBody } from "./frontstore.js";

/*
  Write endpoints for the Settings page (#145): POST/DELETE /api/local/secrets
  and /api/local/vars. Gated by the caller (front.ts) exactly like every other
  /api/local surface — loopback always, basic auth when configured.

  These call the SAME store functions the `ndh secrets` / `ndh vars` commands
  use (setSecret/removeSecret, setVar/removeVar), so the active backend
  (keychain / libsecret / encrypted file) and the global/repo scope model are
  honored identically. Nothing here shells out to the CLI.

  Secret values are WRITE-ONLY on this surface: no response — success, error,
  or list (/api/local/config) — ever echoes a secret value back. Name
  validation is the CLI's own `validEnvName`, checked HERE because the store's
  own guard is `fail()` (process.exit) — a bad name must 400, not kill the hub.

  Byte semantics (#135/#143): the stored value is EXACTLY the JSON string the
  client sent — the same contract as piped stdin / `--value`. No newline is
  added or removed; the interactive prompt's Enter-terminates rule does not
  apply to the web form.
*/

const JSON_HEADERS = { "content-type": "application/json" } as const;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** The CLI's invalid-name message, verbatim (secrets.ts / vars.ts `fail`). */
function badNameMsg(name: string): string {
  return `invalid name '${name}' — use letters, digits, and underscore; must not start with a digit`;
}

/**
 * Resolve a request's scope: absent/"global" → global, an `owner/repo` slug →
 * that repo scope (repo overrides global at run time, same as `--repo`).
 * Returns null for anything else — there is no cwd to infer a repo from here.
 */
export function parseScope(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "" || raw === GLOBAL_SCOPE) return GLOBAL_SCOPE;
  if (typeof raw === "string" && /^[^/\s]+\/[^/\s]+$/.test(raw)) return raw;
  return null;
}

interface WriteBody {
  name: string;
  value: string;
  scope: string;
}

/** Validate a POST body ({ name, value, scope? }) into a write, or answer 4xx and return null. */
async function readWriteBody(
  req: IncomingMessage,
  res: ServerResponse,
  emptyValueMsg: string,
): Promise<WriteBody | null> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    json(res, 400, { ok: false, error: String((err as Error).message ?? err) });
    return null;
  }
  const o = (body ?? {}) as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  if (!validEnvName(name)) {
    json(res, 400, { ok: false, error: badNameMsg(name) });
    return null;
  }
  if (typeof o.value !== "string" || o.value === "") {
    json(res, 400, { ok: false, error: emptyValueMsg });
    return null;
  }
  const scope = parseScope(o.scope);
  if (scope === null) {
    json(res, 400, { ok: false, error: "scope must be 'global' or an owner/repo slug" });
    return null;
  }
  return { name, value: o.value, scope };
}

/** Validate DELETE query params (?name=…&scope=…), or answer 400 and return null. */
function readDeleteParams(url: URL, res: ServerResponse): { name: string; scope: string } | null {
  const name = url.searchParams.get("name") ?? "";
  if (!validEnvName(name)) {
    json(res, 400, { ok: false, error: badNameMsg(name) });
    return null;
  }
  const scope = parseScope(url.searchParams.get("scope") ?? undefined);
  if (scope === null) {
    json(res, 400, { ok: false, error: "scope must be 'global' or an owner/repo slug" });
    return null;
  }
  return { name, scope };
}

function methodNotAllowed(res: ServerResponse): void {
  // Reads stay on GET /api/local/config (names + scopes for secrets, never values).
  res.writeHead(405, { ...JSON_HEADERS, allow: "POST, DELETE" });
  res.end(JSON.stringify({ ok: false, error: "method not allowed — read via /api/local/config" }));
}

/**
 * /api/local/secrets — write-through to the `ndh secrets` store:
 *   POST    → store one ({ name, value, scope? }); the value is never echoed back
 *   DELETE  → remove one (?name=…&scope=…); idempotent, reports `removed`
 * A store failure (e.g. a locked headless Keychain) surfaces its message
 * verbatim — including the #42 "run 'ndh secrets backend file'" hint.
 */
export async function serveSecretsCrud(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  if (req.method === "POST") {
    const w = await readWriteBody(req, res, "empty secret value");
    if (!w) return;
    try {
      await setSecret(w.scope, w.name, w.value);
    } catch (err) {
      json(res, 500, { ok: false, error: (err as Error).message ?? String(err) });
      return;
    }
    json(res, 200, { ok: true, name: w.name, scope: w.scope, backend: backendName() });
    return;
  }
  if (req.method === "DELETE") {
    const p = readDeleteParams(url, res);
    if (!p) return;
    try {
      const removed = await removeSecret(p.scope, p.name);
      json(res, 200, { ok: true, name: p.name, scope: p.scope, removed });
    } catch (err) {
      json(res, 500, { ok: false, error: (err as Error).message ?? String(err) });
    }
    return;
  }
  methodNotAllowed(res);
}

/**
 * /api/local/vars — write-through to the `ndh vars` store:
 *   POST    → store one ({ name, value, scope? })
 *   DELETE  → remove one (?name=…&scope=…); idempotent, reports `removed`
 * Vars are not secret; /api/local/config lists them with values.
 */
export async function serveVarsCrud(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  if (req.method === "POST") {
    const w = await readWriteBody(req, res, "empty variable value");
    if (!w) return;
    try {
      await setVar(w.scope, w.name, w.value);
    } catch (err) {
      json(res, 500, { ok: false, error: (err as Error).message ?? String(err) });
      return;
    }
    json(res, 200, { ok: true, name: w.name, scope: w.scope });
    return;
  }
  if (req.method === "DELETE") {
    const p = readDeleteParams(url, res);
    if (!p) return;
    try {
      const removed = await removeVar(p.scope, p.name);
      json(res, 200, { ok: true, name: p.name, scope: p.scope, removed });
    } catch (err) {
      json(res, 500, { ok: false, error: (err as Error).message ?? String(err) });
    }
    return;
  }
  methodNotAllowed(res);
}
