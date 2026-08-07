import type { ServerResponse } from "node:http";
import { log, unwrap } from "./lib.js";
import { hostedToSelfHosted } from "./platform.js";
import { hasCompleteTree } from "./treecache.js";

/**
 * Hub-side platform mapping (#92). Investigation result, kept here as the record:
 *
 * The vendored engine (ChristopherHX/runner.server, checked at v3.14.0 AND current main) has NO
 * server-side default platform / runs-on mapping — no appsettings key, no `Runner.Server__*` env.
 * The `-P ubuntu-latest=-self-hosted` mapping `ndh dispatch` relies on exists only as per-request
 * `platform` query params on `POST /_apis/v1/Message/schedule2` (MessageController.OnSchedule2),
 * is applied at queue time (queueJob), and is NOT persisted with the run. The native re-run
 * endpoints (`rerunworkflow/{id}`, `rerunFailed/{id}`) re-queue the stored workflow with
 * `platform: null` (RerunWorkflow2 → ConvertYaml2), so any run that needed the mapping re-runs
 * into "No runner is registered for the requested runs-on labels: [ubuntu-latest]".
 *
 * So the hub front — the one server-side box we own on every request path — supplies the mapping:
 *
 *  1. Dispatch (and git-hook, which shells out to `ndh dispatch`): a proxied `schedule2` carrying
 *     no `platform` param gets the default hosted→self-hosted mapping appended to its query
 *     (appendDefaultPlatform). An explicit `-P` from the dispatcher passes through untouched.
 *  2. Re-run: the front intercepts the native re-run POSTs and replays them through the engine's
 *     own `schedule2?runid=<id>` path (serveRerun) — the engine's sanctioned "new attempt of an
 *     existing run" API (ConvertYaml's rrunid branch), which accepts `platform` — using the data
 *     the engine retained with the latest attempt: full workflow YAML, event payload, event name,
 *     ref and sha. Attempt numbering, artifact scoping and failed-only semantics all match the
 *     native endpoints because it is the same server code path that serves them.
 *
 * The engine only rewrites a job whose whole runs-on label set is covered by one mapping entry,
 * so `runs-on: self-hosted` (or any native label set) is untouched by the defaults.
 */

/** Engine base for a local hub. */
function apiBase(hubPort: number): string {
  return `http://127.0.0.1:${hubPort}/_apis/v1/Message`;
}

/**
 * Rewrite a proxied `schedule2` request path: when the dispatcher supplied no `platform` mapping,
 * append the hub default so `runs-on: ubuntu-latest` (& co) resolves to the self-hosted fleet.
 * A request that carries any `platform` param is returned byte-identical — explicit mappings win.
 */
export function appendDefaultPlatform(reqUrl: string): string {
  const u = new URL(reqUrl, "http://localhost");
  if (u.searchParams.has("platform")) return reqUrl;
  for (const p of hostedToSelfHosted()) u.searchParams.append("platform", p);
  return u.pathname + u.search;
}

/** The slice of an engine attempt record the replay needs (camelCase, as the engine serializes). */
interface AttemptRec {
  attempt?: number;
  eventName?: string | null;
  eventPayload?: string | null;
  workflow?: string | null;
  ref?: string | null;
  sha?: string | null;
}

/** Injectable seams so tests can drive the replay without a live engine. */
export interface RerunMapDeps {
  fetch?: typeof fetch;
  /** Test seam over treecache.hasCompleteTree. */
  hasTree?: (runId: number) => Promise<boolean>;
  /** The hub's `--github-token`, when configured — it makes REAL actions/checkout viable. */
  githubToken?: string;
}

/**
 * #110: does the stored workflow resolve actions/checkout? The engine's localcheckout
 * substitution is keyed on exactly that action name (the job JWT's `localcheckout` claim,
 * matched by NameWithOwner in ActionDownloadInfoController), at any ref.
 */
export function workflowUsesCheckout(yaml: string): boolean {
  return /(^|[^a-z0-9_])uses\s*:\s*["']?actions\/checkout@/im.test(yaml);
}

/** The one honest refusal (issue #110 path 2) — shown verbatim by the UI and `ndh run rerun`. */
export const TREE_GONE =
  "this run's source tree is not on the hub — re-dispatch it from the checkout with 'ndh dispatch'";

/**
 * Replay a re-run of `runId` through `schedule2?runid=...` with the default platform mapping.
 *
 * Returns true when it handled the response (success or a reported upstream failure), false when
 * the replay could not even be assembled (attempts unreadable, no stored workflow YAML) — the
 * caller then falls back to proxying the native re-run endpoint, which is exactly the pre-#92
 * behavior and still correct for workflows that never needed a mapping.
 */
export async function serveRerun(
  hubPort: number,
  runId: number,
  failed: boolean,
  res: ServerResponse,
  deps: RerunMapDeps = {},
): Promise<boolean> {
  const doFetch = deps.fetch ?? fetch;
  const base = apiBase(hubPort);

  // Everything a new attempt needs is retained on the latest attempt record.
  let latest: AttemptRec | undefined;
  let fileName = "";
  try {
    const ares = await doFetch(`${base}/workflow/run/${runId}/attempts`);
    if (!ares.ok) return false;
    const attempts = unwrap<AttemptRec>(await ares.json());
    latest = attempts.reduce<AttemptRec | undefined>(
      (a, b) => (a === undefined || (b.attempt ?? 0) > (a.attempt ?? 0) ? b : a),
      undefined,
    );
    const rres = await doFetch(`${base}/workflow/run/${runId}`);
    if (rres.ok) fileName = ((await rres.json()) as { fileName?: string | null })?.fileName ?? "";
  } catch {
    return false;
  }
  if (!latest?.workflow) return false;

  // #110: carry the SAME localcheckout wiring the original dispatch used. The engine keeps no
  // record of it (schedule2's `localcheckout` is per-request, default true from Runner.Client),
  // so the front's own tree cache is the signal: a retained tree exists exactly when the
  // original attempt's checkout streamed the local tree through this front. With the wiring on,
  // the replayed attempt's checkout is served from that cache (treecache.ts). Without a tree,
  // a workflow that resolves actions/checkout would fall through to the REAL action, whose
  // required `token` input is empty unless the hub carries a github token — that attempt is
  // doomed ("Input required and not supplied: token"), so refuse it honestly instead.
  const localTree = await (deps.hasTree ?? hasCompleteTree)(runId);
  if (!localTree && workflowUsesCheckout(latest.workflow) && !deps.githubToken) {
    log(`re-run of #${runId} refused: ${TREE_GONE}`);
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: TREE_GONE, runId }));
    return true;
  }

  // The dispatch-time event payload carries the project slug; hand it back explicitly so the
  // re-run stays attributed to the same owner/repo (the rrunid branch does not re-read the DB).
  let repository: string | null = null;
  try {
    const payload = JSON.parse(latest.eventPayload ?? "") as { repository?: { full_name?: string } };
    repository = payload?.repository?.full_name ?? null;
  } catch {
    /* no payload / not JSON — the engine falls back to parsing the posted event itself */
  }

  const target = new URL(`${base}/schedule2`);
  target.searchParams.set("runid", String(runId));
  // Localcheckout wiring as decided above; artifacts reset on a full re-run only.
  target.searchParams.set("localcheckout", localTree ? "true" : "false");
  target.searchParams.set("resetArtifacts", failed ? "false" : "true");
  if (failed) target.searchParams.set("failed", "true");
  if (latest.ref) target.searchParams.set("Ref", latest.ref);
  if (latest.sha) target.searchParams.set("Sha", latest.sha);
  if (repository) target.searchParams.set("Repository", repository);
  for (const p of hostedToSelfHosted()) target.searchParams.append("platform", p);

  const form = new FormData();
  form.append("event", new Blob([latest.eventPayload ?? "{}"], { type: "application/json" }), "event.json");
  form.append("workflow", new Blob([latest.workflow]), fileName || "workflow.yml");

  let up: Response;
  try {
    up = await doFetch(target, {
      method: "POST",
      headers: { "X-GitHub-Event": latest.eventName || "push" },
      body: form,
    });
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(err), runId }));
    return true;
  }
  if (!up.ok) {
    void up.body?.cancel().catch(() => {});
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `engine returned ${up.status}`, runId }));
    return true;
  }

  // schedule2 answers with the engine's live SSE feed for the new attempt, held open until it
  // finishes. The re-run POST contract is fire-and-forget (the native endpoint returns at once),
  // so acknowledge now and drain the feed in the background — dropping it early is the one thing
  // we must not do while the request that carries the scheduling is still being served.
  void drain(up).catch(() => {});
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, runId, attempt: (latest.attempt ?? 0) + 1 }));
  return true;
}

/** Consume an SSE response body to the end (or upstream close); never throws to the caller. */
async function drain(up: Response): Promise<void> {
  if (!up.body) return;
  try {
    for await (const chunk of up.body) void chunk;
  } catch (err) {
    /* c8 ignore next — an aborted feed after scheduling is harmless; the run continues server-side */
    log(`re-run feed closed early: ${String(err)}`);
  }
}

/** Exposed for tests. */
export const __test = { apiBase, drain };
