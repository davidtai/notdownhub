import { log } from "./lib.js";

/**
 * `ndh run cancel <id>` and `ndh run delete <id> | --project <owner/repo>`.
 *
 * Both are `run` subcommands, so main() routes them here before the verbatim `run` passthrough to
 * Runner.Client. They talk to a hub's front over HTTP: cancel and single/bulk delete all ride the
 * front's gated /api/local/runs endpoints (loopback, or basic-auth for a remote hub) — the same
 * gate every other UI-originated mutation uses. Bulk delete is a client-side loop over the same
 * single-run contract the UI (and #55's Projects page) call, so there is no bespoke server state.
 */

const DEFAULT_SERVER = "http://localhost:4949";

/** HTTP seam so tests observe the exact requests without a live hub. */
export interface HttpDeps {
  fetchImpl?: typeof fetch;
}

interface Parsed {
  positionals: string[];
  server: string;
  project?: string;
}

/** Minimal flag parser for the intercepted `run cancel|delete` argv (commander never sees these). */
export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  let server = DEFAULT_SERVER;
  let project: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") server = argv[++i] ?? server;
    else if (a.startsWith("--server=")) server = a.slice("--server=".length);
    else if (a === "--project") project = argv[++i];
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
    else positionals.push(a);
  }
  return { positionals, server, project };
}

function baseUrl(server: string): string {
  return server.endsWith("/") ? server.slice(0, -1) : server;
}

/**
 * `ndh run cancel <id> --server <hub>` — cancel a running (or orphaned) run. Uses the front's
 * cancel endpoint, which drives the engine's forceCancelWorkflow: the reliable stop, and the
 * recovery for an abandoned `ndh dispatch` that left the run stuck "running" and the runner busy.
 */
export async function runCancelCmd(argv: string[], deps: HttpDeps = {}): Promise<number> {
  const doFetch = deps.fetchImpl ?? fetch;
  const { positionals, server } = parseArgs(argv);
  const id = positionals[0];
  if (!id || !/^\d+$/.test(id)) {
    console.error("usage: ndh run cancel <id> --server http://hub:4949");
    return 2;
  }
  let res: Response;
  try {
    res = await doFetch(`${baseUrl(server)}/api/local/runs/${id}/cancel`, { method: "POST" });
  } catch (err) {
    console.error(`[ndh] could not reach ${server}: ${err}`);
    return 1;
  }
  if (!res.ok) {
    console.error(`[ndh] cancel failed: ${server} → ${res.status} ${res.statusText}`);
    return 1;
  }
  log(`requested cancel of run #${id}`);
  return 0;
}

/** DELETE one run through the front; returns rows purged, or throws on a non-OK response. */
async function deleteOne(doFetch: typeof fetch, server: string, id: number): Promise<number> {
  const res = await doFetch(`${baseUrl(server)}/api/local/runs/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${server}/api/local/runs/${id} → ${res.status} ${res.statusText}`);
  const body = (await res.json().catch(() => ({}))) as { logsPurged?: number };
  return body.logsPurged ?? 0;
}

/** `ndh run delete <id> --server <hub>` or `ndh run delete --project <owner/repo> --server <hub>`. */
export async function runDeleteCmd(argv: string[], deps: HttpDeps = {}): Promise<number> {
  const doFetch = deps.fetchImpl ?? fetch;
  const { positionals, server, project } = parseArgs(argv);

  if (project) {
    // Bulk delete rides the front's single contract (DELETE /api/local/runs?project=...) — the
    // same endpoint #55's Projects page "Remove" uses — so the server does the loop, not us.
    let res: Response;
    try {
      res = await doFetch(`${baseUrl(server)}/api/local/runs?project=${encodeURIComponent(project)}`, { method: "DELETE" });
    } catch (err) {
      console.error(`[ndh] could not reach ${server}: ${err}`);
      return 1;
    }
    const body = (await res.json().catch(() => ({}))) as { deleted?: number; failed?: number };
    if (!res.ok && res.status !== 207) {
      console.error(`[ndh] delete failed: ${server} → ${res.status} ${res.statusText}`);
      return 1;
    }
    log(`deleted ${body.deleted ?? 0} run(s) for ${project}${body.failed ? ` (${body.failed} failed)` : ""}`);
    return body.failed ? 1 : 0;
  }

  const id = positionals[0];
  if (!id || !/^\d+$/.test(id)) {
    console.error("usage: ndh run delete <id> --server http://hub:4949\n       ndh run delete --project <owner/repo> --server http://hub:4949");
    return 2;
  }
  try {
    const purged = await deleteOne(doFetch, server, Number(id));
    log(`deleted run #${id} (purged ${purged} log rows)`);
    return 0;
  } catch (err) {
    console.error(`[ndh] ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}
