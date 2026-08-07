import { log, unwrap } from "./lib.js";

/**
 * `ndh run rerun <id> --server <hub>` — re-run a finished run on the hub's fleet.
 *
 * Reality-check (see the PR / docs/operations.md): the bundled Runner.Server
 * exposes a native re-run. `ndh` calls it rather than re-implementing dispatch,
 * because the hub already retains everything an attempt needs — the full
 * workflow YAML, the event payload, and the ref/sha — per attempt. Re-running
 * POSTs to that endpoint; the server re-queues the recorded workflow as a NEW
 * ATTEMPT of the same run (exactly like GitHub's "Re-run"), so the re-run stays
 * attributed to the same project and is linked to the original run by id.
 *
 *   POST _apis/v1/Message/rerunworkflow/{id}   re-run the whole workflow
 *   POST _apis/v1/Message/rerunFailed/{id}     re-run only the failed jobs
 *
 * Honest limitation: a workflow whose `actions/checkout` copies the *dispatched
 * local working tree* cannot be reproduced from the hub — that tree lived on the
 * machine that ran `ndh dispatch`, and the hub never retained it. Such a re-run
 * executes, but its checkout step fails ("Input required and not supplied:
 * token"). Re-run those from the checkout with `ndh dispatch`.
 */

const USAGE = `usage: ndh run rerun <run-id> --server <hub> [--failed]

Re-run a finished run on the hub's fleet. The hub re-queues the recorded workflow
at the same ref/sha as a NEW ATTEMPT of the same run (matching GitHub's Re-run),
so it stays attributed to the same project and links to the original run.

  --server <url>   hub base url (required)
  --failed         re-run only the failed jobs (default: the whole workflow)

Note: a workflow that checks out the dispatched local working tree cannot be
re-run from the hub — that tree lived on the machine that dispatched it. Re-run
such workflows from the checkout with 'ndh dispatch'.`;

export interface RerunArgs {
  id?: string;
  server?: string;
  failed: boolean;
  help: boolean;
}

/** Parse `rerun` argv by hand (like dispatch): a positional id + --server/--failed/--help. */
export function parseRerunArgs(argv: string[]): RerunArgs {
  const out: RerunArgs = { failed: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--failed") out.failed = true;
    else if (a === "--server") out.server = argv[++i];
    else if (a.startsWith("--server=")) out.server = a.slice("--server=".length);
    else if (!a.startsWith("-") && out.id === undefined) out.id = a;
    // anything else is ignored — the id/server/flags above are the whole surface
  }
  return out;
}

interface RunMeta {
  id?: number;
  displayName?: string;
  fileName?: string;
  owner?: string | null;
  repo?: string | null;
}

/** `owner/repo`, or whichever half the run carries — mirrors the UI's projectLabel. */
function projectLabel(r: RunMeta): string {
  const owner = r.owner?.trim();
  const repo = r.repo?.trim();
  if (owner && repo) return `${owner}/${repo}`;
  return repo || owner || "local";
}

/**
 * Locate a run in the hub's paginated runs list. Two jobs:
 *  1. name the project — the single-run endpoint (`workflow/run/{id}`) does NOT
 *     populate owner/repo, only the list does, so we page the list to label the
 *     re-run correctly (never a wrong "local"/"Unknown" for a real run);
 *  2. confirm the run exists — the engine's `rerunworkflow` POST returns 200
 *     even for a nonexistent id, so the POST is not an existence check; the list
 *     is the only honest one we have.
 *
 * Result:
 *  - a RunMeta when found;
 *  - "absent" when the whole list was scanned to its end and the id is not there
 *    (a definitively wrong id — the caller refuses instead of a false success);
 *  - "unknown" when we could not read the list (fetch/parse error) or the scan
 *    hit its page cap without an empty page — we then let the POST proceed rather
 *    than block a possibly-valid re-run on a very large hub.
 */
type FindResult = RunMeta | "absent" | "unknown";

async function findRun(base: string, id: number, doFetch: typeof fetch): Promise<FindResult> {
  for (let page = 0; page < 50; page++) {
    let rows: RunMeta[];
    try {
      const res = await doFetch(new URL(`_apis/v1/Message/workflow/runs?page=${page}`, base));
      if (!res.ok) return "unknown";
      rows = unwrap<RunMeta>(await res.json());
    } catch {
      return "unknown";
    }
    if (rows.length === 0) return "absent"; // reached the end of the list — id is not present
    const hit = rows.find((r) => r.id === id);
    if (hit) return hit;
  }
  return "unknown"; // hit the page cap without an empty page — can't be sure; don't block
}

/** Seams so tests can drive the command without a live hub. */
export interface RerunDeps {
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

/** `ndh run rerun <id> --server <hub> [--failed]`. Returns the process exit code. */
export async function rerunCmd(argv: string[], deps: RerunDeps = {}): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const say = deps.log ?? log;
  const err = deps.error ?? ((m: string) => console.error(`\x1b[31m[ndh]\x1b[0m ${m}`));

  const args = parseRerunArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.server) {
    err("missing --server");
    console.error(USAGE);
    return 2;
  }
  if (args.id === undefined) {
    err("missing <run-id>");
    console.error(USAGE);
    return 2;
  }
  const id = Number(args.id);
  if (!Number.isInteger(id) || id <= 0) {
    err(`invalid run id '${args.id}' — expected a positive integer`);
    return 2;
  }

  const base = args.server.endsWith("/") ? args.server : `${args.server}/`;

  // Look the run up in the list: names the project, and is our only honest
  // existence check (the POST 200s even for a bad id). A definitively-absent run
  // is refused here; an unreadable list falls through to the POST.
  const found = await findRun(base, id, doFetch);
  if (found === "absent") {
    err(`no run #${id} on ${args.server}`);
    return 1;
  }
  const meta: RunMeta | null = found === "unknown" ? null : found;

  const verb = args.failed ? "rerunFailed" : "rerunworkflow";
  let res: Response;
  try {
    res = await doFetch(new URL(`_apis/v1/Message/${verb}/${id}`, base), { method: "POST" });
  } catch (e) {
    err(`could not reach hub at ${args.server}: ${(e as Error).message}`);
    return 1;
  }
  if (!res.ok) {
    const hint = res.status === 404 ? " — no run #" + id + " on this hub?" : "";
    err(`re-run failed: hub returned ${res.status} ${res.statusText} for #${id}${hint}`);
    return 1;
  }

  const what = meta ? ` (${projectLabel(meta)} · ${meta.displayName || meta.fileName || `run ${id}`})` : "";
  say(`re-run queued for #${id}${what}${args.failed ? " — failed jobs only" : ""}`);
  say(`a new attempt on the same run will execute on the fleet — watch it: ndh status --server ${args.server}`);
  return 0;
}

/** Exposed for tests. */
export const __test = { parseRerunArgs, projectLabel, USAGE };
