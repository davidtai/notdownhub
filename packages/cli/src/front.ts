import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { download, exists, log, ndhHome } from "./lib.js";
import { getAgentsInfo } from "./agents-info.js";
import { serveJobLogs, isRunDeleted, joblogsDbPath } from "./joblogs.js";
import { getConfigInfo } from "./config-info.js";
import { listArtifacts, parseArtifactApiPath, parseArtifactPrettyUrl, serveArtifactDownload } from "./artifacts.js";
import { serveRunCancel, serveRunDelete, serveFilteredRuns, serveProjectDelete } from "./runctl.js";
import { serveProjects } from "./projects.js";
import { appendDefaultPlatform, serveRerun } from "./rerunmap.js";
import { serveRunsMeta } from "./runs-meta.js";
import { serveLocalcheckout } from "./localcheckout.js";
import { serveInnerLocalcheckout } from "./localcheckout-inner.js";
import { serveOrRetainTree } from "./treecache.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export interface FrontOptions {
  port: number;
  hubPort: number;
  uiDir: string | null;
  /** Hub registration token; lets the proxy mint read-only management JWTs for the agent-status APIs. */
  runnerToken?: string;
  /** Fleet-reachable host for join commands shown in the UI (mirror URLs use the same value). */
  host?: string;
  /** "user:pass" — when set, non-loopback clients may access the UI/join-info with Basic auth. */
  basicAuth?: string;
  /** TLS material; when set the front serves HTTPS. */
  tls?: { key: Buffer; cert: Buffer };
  /** GitHub token for authenticated mirror fetches (from `--github-token`). */
  githubToken?: string;
}

/** The UI (and its join-info endpoint) is local-only: the operator at the hub machine. */
function isLoopback(addr: string | undefined): boolean {
  const a = addr ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function basicAuthOk(req: http.IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const given = Buffer.from(header.slice(6), "base64");
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Loopback always; otherwise Basic auth when configured. Gates UI + join-info only. */
function uiAccessAllowed(req: http.IncomingMessage, opts: FrontOptions): boolean {
  if (isLoopback(req.socket.remoteAddress)) return true;
  return Boolean(opts.basicAuth) && basicAuthOk(req, opts.basicAuth!);
}

function denyUi(res: http.ServerResponse, opts: FrontOptions): void {
  if (opts.basicAuth) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="notdownhub"' });
    res.end("authentication required");
  } else {
    res.writeHead(403);
    res.end("the notdownhub UI is local-only; API and runner protocol remain available on this port");
  }
}

/** The hub's Agent* endpoints require a management JWT even for reads; mint one via the registration route. */
export function managementJwt(hubPort: number, runnerToken: string | undefined) {
  let cached: { token: string; at: number } | null = null;
  return async (): Promise<string | null> => {
    if (cached && Date.now() - cached.at < 45 * 60_000) return cached.token;
    const res = await fetch(`http://127.0.0.1:${hubPort}/api/v3/actions/runner-registration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `RemoteAuth ${runnerToken ?? "none"}` },
      body: JSON.stringify({ url: `http://127.0.0.1:${hubPort}/runner/server`, runner_event: "register" }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    if (!body.token) return null;
    cached = { token: body.token, at: Date.now() };
    return body.token;
  };
}

/**
 * Single public entry point for a notdownhub hub:
 *   /mirror/<owner>/<repo>/(tarball|zipball)/<ref>  cached action archives (offline after first fetch)
 *   /ui and static assets                            the web app
 *   everything else                                  streamed through to Runner.Server (API, runner
 *                                                    protocol, SSE) so no CORS and one port to expose
 */
/** Mint a management JWT: the async factory returned by managementJwt(). */
type Mint = () => Promise<string | null>;

/** Route a single request (extracted from startFront so the branch decisions are unit-testable). */
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: FrontOptions,
  mint: Mint,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let m: RegExpMatchArray | null;
    if (url.pathname.startsWith("/mirror/")) {
      await serveMirror(url.pathname, res, opts.githubToken);
    } else if (url.pathname === "/api/local/join-info") {
      // Pairing info for the UI. The token must not leak to arbitrary readers — a remote
      // reader could register rogue runners with it. Loopback always; basic auth if configured.
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          host: opts.host ?? "localhost",
          port: opts.port,
          token: opts.runnerToken ?? null,
          authEnabled: Boolean(opts.runnerToken),
        }),
      );
    } else if (url.pathname === "/api/local/agents") {
      // Runner list enriched with labels (from the hub DB) and Active/Idle/Offline
      // state. Same local-only gate as join-info; degrades to an empty list on error.
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      const agents = await getAgentsInfo(opts.hubPort, mint).catch(() => []);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(agents));
    } else if (url.pathname === "/api/local/config") {
      // Read-only secrets (names only) + variables for the Settings page.
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      const config = await getConfigInfo().catch(() => ({ backend: "unknown", secrets: [], vars: [] }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(config));
    } else if (url.pathname === "/api/local/projects") {
      // Distinct projects across the FULL run history (issue #90), aggregated hub-side so the
      // Projects page never derives its list from one runs page. Same gate as the other reads.
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      await serveProjects(opts.hubPort, res);
    } else if (url.pathname === "/api/local/runs-meta") {
      // Batch per-run timing for the runs list/detail (issue #96): startedAt/finishedAt/
      // durationMs keyed by run id, from the hub DB's Job timeline records — the same
      // source `ndh status` reads (#76). ONE DB read serves the whole batch of ids (the
      // UI sends a page of ids at a time, never one request per row). Same gate as the
      // other /api/local reads; runner-protocol paths are untouched.
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      await serveRunsMeta(url.searchParams.get("ids"), res);
    } else if (url.pathname === "/api/local/joblogs" || url.pathname.startsWith("/api/local/joblogs/")) {
      // Persisted console output for a completed run's job (survives hub restarts).
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      await serveJobLogs(url.pathname, res);
    } else if (parseArtifactApiPath(url.pathname)) {
      // A run's artifacts (list) + the archive download, for the UI. Same local-only gate as the
      // other /api/local reads — a UI-initiated download rides the same rule as the rest of the UI.
      // (The raw /_apis/pipelines/... artifact endpoints stay proxied below so the RUNNER can still
      // upload and a direct/CLI client can still fetch; only these convenience paths are UI-gated.)
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      const { runId, selector } = parseArtifactApiPath(url.pathname)!;
      const base = `http://127.0.0.1:${opts.hubPort}`;
      if (selector === null) {
        const list = await listArtifacts(base, runId).catch(() => []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(list));
      } else {
        await serveArtifactDownload(base, runId, selector, res);
      }
    } else if (parseArtifactPrettyUrl(url.pathname)) {
      // The exact URL actions/upload-artifact prints in the job log. github.server_url now points at
      // this hub (hub.ts sets Runner.Server__GitServerUrl), so instead of a dead github.com link the
      // operator gets the real artifact archive. Gated like the UI download it resolves to.
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      const { runId, artifactId } = parseArtifactPrettyUrl(url.pathname)!;
      await serveArtifactDownload(`http://127.0.0.1:${opts.hubPort}`, runId, artifactId, res);
    } else if ((m = url.pathname.match(/^\/api\/local\/runs\/(\d+)\/cancel$/)) && req.method === "POST") {
      // Cancel a run through the engine's own cancellation endpoint. Mutating + UI-originated,
      // so it rides the same local-only / basic-auth gate as the rest of /api/local.
      // Default = forceCancelWorkflow: the engine's soft cancelWorkflow re-evaluates each job's
      // `if:` and skips jobs without one, so it does not stop a normal running job (verified) —
      // force reliably terminates the run and is the recovery path for an orphaned dispatch.
      // `?soft=1` selects the graceful cancelWorkflow for callers that want GitHub's semantics.
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      const graceful = url.searchParams.get("soft") === "1";
      await serveRunCancel(opts.hubPort, Number(m[1]), !graceful, res);
    } else if ((m = url.pathname.match(/^\/api\/local\/runs\/(\d+)$/)) && req.method === "DELETE") {
      // True delete: tombstone + purge persisted logs. Same gate as cancel.
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      await serveRunDelete(Number(m[1]), res);
    } else if (url.pathname === "/api/local/runs" && req.method === "DELETE") {
      // Bulk delete every run of a project — the #55 Projects page "Remove" action and
      // `ndh run delete --project`. Contract: DELETE /api/local/runs?project=<owner/repo>.
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      await serveProjectDelete(opts.hubPort, url.searchParams.get("project"), res);
    } else if (url.pathname === "/api/local/runs" && req.method === "OPTIONS") {
      // Capability probe for the Projects page: a non-404 here tells the UI the project-delete
      // backend exists so it can reveal the Remove control. No data, so it is not gated.
      res.writeHead(204, { allow: "DELETE, OPTIONS" });
      res.end();
    } else if (
      req.method === "POST" &&
      (m = url.pathname.match(/^\/_apis\/v1\/Message\/(rerunworkflow|rerunFailed)\/(\d+)\/?$/i)) &&
      url.searchParams.get("onLatestCommit") !== "true"
    ) {
      // #92: the engine's native re-run re-queues the stored workflow with NO platform mapping,
      // so any run dispatched with (or needing) `-P ubuntu-latest=-self-hosted` re-runs into
      // "no runner registered for ubuntu-latest". Replay it through schedule2?runid=<id> with the
      // hub's default mapping instead (see rerunmap.ts). Not gated, exactly like the proxied
      // native endpoint it replaces — `ndh run rerun` calls it from remote machines. On any
      // shape we cannot replay (unreadable attempts, no stored YAML, onLatestCommit) fall back
      // to the native endpoint — the pre-#92 behavior. #110: the replay also carries the
      // localcheckout wiring (and may refuse honestly) — see rerunmap.ts.
      if (!(await serveRerun(opts.hubPort, Number(m[2]), /failed/i.test(m[1]), res, { githubToken: opts.githubToken }))) {
        proxy(req, res, opts.hubPort);
      }
    } else if (req.method === "GET" && /\/_apis\/v1\/ActionDownloadInfo\/localcheckout$/i.test(url.pathname)) {
      // #98: the engine's localcheckout composite passes `fetch-tags` to an inner action that
      // does not declare it — an "Unexpected input(s)" warning annotation on every localcheckout
      // run — and drops modern checkout inputs on the local path. Runners download actions
      // through this front, so serve the ndh-owned checkout@v4-parity composite instead
      // (localcheckout.ts). Any shape we cannot render falls back to the engine's own shim.
      if (!(await serveLocalcheckout(opts.hubPort, url, res))) {
        proxy(req, res, opts.hubPort);
      }
    } else if (req.method === "GET" && /\/localcheckout\.(tar\.gz|zip)$/i.test(url.pathname)) {
      // #107: the composite's INNER step resolves to the engine's static inner action
      // (wwwroot/localcheckout.tar.gz|.zip — the hub mints these URLs from the Host header, so
      // runners fetch them through this front). Its ancient bundled @actions/core stamps the
      // set-output deprecation warning on every localcheckout run. Serve the ndh-owned
      // dependency-free inner action instead (localcheckout-inner.ts); on any failure — or
      // NDH_INNER_LOCALCHECKOUT=engine — proxy the engine's original archive unchanged.
      // (/localcheckoutazure.zip does not match and stays proxied.)
      if (!serveInnerLocalcheckout(url.pathname, res)) {
        proxy(req, res, opts.hubPort);
      }
    } else if (req.method === "GET" && (m = url.pathname.match(/\/_apis\/v1\/Message\/multipart\/(\d+)\/?$/i))) {
      // #110: the dispatched tree streams through here exactly once — the original attempt's
      // checkout (the engine round-trips it to the still-attached dispatch client and stores
      // nothing). Tee it into the per-run tree cache, and serve later identical requests from
      // that cache — that is what lets a replayed re-run attempt check out after the dispatch
      // client exited. Suffix match: ACTIONS_RUNTIME_URL may carry a tenant path prefix.
      await serveOrRetainTree(req, res, opts.hubPort, Number(m[1]), url.searchParams);
    } else if (req.method === "POST" && url.pathname.match(/^\/_apis\/v1\/Message\/schedule2\/?$/i)) {
      // Dispatch without an explicit -P gets the same default mapping, appended to the proxied
      // query (never overriding a supplied one). Body streams through untouched.
      proxy(req, res, opts.hubPort, null, appendDefaultPlatform(req.url ?? url.pathname));
    } else if (req.method === "GET" && url.pathname === "/_apis/v1/Message/workflow/runs") {
      // Runs list, proxied with tombstoned runs filtered out (for every reader). Not gated: the
      // list is a read, same as proxying it straight through — deletion is just enforced here.
      await serveFilteredRuns(opts.hubPort, url.search, res);
    } else if (
      req.method === "GET" &&
      (m = url.pathname.match(/^\/_apis\/v1\/Message\/workflow\/run\/(\d+)(?:\/.*)?$/)) &&
      (await isRunDeleted(joblogsDbPath(), Number(m[1])))
    ) {
      // A deleted run's detail (run, attempts, jobs) 404s so the UI shows "gone", not stale data.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "run deleted", runId: Number(m[1]) }));
    } else if (opts.uiDir && !uiAccessAllowed(req, opts) && isUiPath(url.pathname)) {
      denyUi(res, opts);
    } else if (opts.uiDir && (await serveUi(opts.uiDir, url.pathname, res))) {
      // served static UI
    } else {
      // The hub's Agent* endpoints demand a management JWT even for reads; grant it to
      // anonymous callers only, so the UI can act without holding secrets. Two shapes:
      //   - reads: any GET under /_apis/v1/Agent(Pools)?/  (runner list + status)
      //   - remove: the single DELETE /_apis/v1/Agent/{poolId}/{agentId} the Runners page
      //     issues to unregister a runner — the same AgentManagement scope the registration
      //     token already carries (config.sh remove uses the identical path).
      // A client-supplied Authorization is never overwritten.
      let bearer: string | null = null;
      const wantsAgentJwt =
        !req.headers.authorization &&
        ((req.method === "GET" && /^\/_apis\/v1\/Agent(Pools)?\//i.test(url.pathname + "/")) ||
          (req.method === "DELETE" && /^\/_apis\/v1\/Agent\/[^/]+\/[^/]+\/?$/i.test(url.pathname)));
      if (wantsAgentJwt) {
        bearer = await mint().catch(() => null);
      }
      proxy(req, res, opts.hubPort, bearer);
    }
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
}

export function startFront(opts: FrontOptions): http.Server {
  const mint = managementJwt(opts.hubPort, opts.runnerToken);
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => handleRequest(req, res, opts, mint);
  const server = opts.tls ? https.createServer({ key: opts.tls.key, cert: opts.tls.cert }, handler) : http.createServer(handler);
  // Runner protocol long-polls (~50s holds); never kill slow requests.
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  server.listen(opts.port);
  return server;
}

function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hubPort: number,
  bearer: string | null = null,
  pathOverride?: string,
): void {
  const headers = bearer ? { ...req.headers, authorization: `Bearer ${bearer}` } : req.headers;
  const upstream = http.request(
    // Host header passes through untouched: the hub mints runner tenant URLs from it,
    // so it must stay the public-facing host:port, not the internal one.
    { host: "127.0.0.1", port: hubPort, path: pathOverride ?? req.url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      // Flush headers immediately so a streaming response (SSE console feed, runner long-poll)
      // establishes at once — the browser's EventSource fires `open` on headers, not first byte,
      // and each upstream chunk is piped straight through with no buffering/compression added.
      res.flushHeaders?.();
      up.pipe(res);
      // If the upstream response dies mid-body (dropped SSE / long-poll), reset the client socket
      // so the consumer sees a broken connection immediately instead of hanging on a half-response.
      up.on("error", () => res.destroy());
      up.on("aborted", () => res.destroy());
    },
  );
  upstream.on("error", () => {
    // Before any headers: return a clean 502. After headers (mid-stream): force-reset, never
    // inject a body into a partially-streamed response.
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("hub unavailable");
    } else {
      res.destroy();
    }
  });
  // If the client goes away, stop the upstream request so its long-poll is not leaked.
  const abort = () => upstream.destroy();
  res.on("close", abort);
  req.on("aborted", abort);
  req.pipe(upstream);
}

/**
 * Paths the static UI would serve — everything except paths the hub itself serves to runners.
 * These MUST always proxy (never be gated as local-only UI), or a remote runner is refused
 * resources it needs: the runner protocol (/_apis, /runner), the action mirror (/mirror), the
 * generic local-repo checkout action the hub builds for a dispatched repo (/localcheckout*), and
 * the cache/results service v2, which actions/cache (and setup-*'s cache) speaks over Twirp at
 * /twirp/github.actions.results.api.v1.CacheService/... (/twirp).
 */
function isUiPath(pathname: string): boolean {
  return !(
    pathname.startsWith("/_apis/") ||
    pathname.startsWith("/runner/") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/mirror/") ||
    pathname.startsWith("/localcheckout") ||
    pathname.startsWith("/twirp/")
  );
}

async function serveUi(uiDir: string, pathname: string, res: http.ServerResponse): Promise<boolean> {
  // Reserve API-ish prefixes for the hub proxy.
  if (!isUiPath(pathname)) return false;
  const clean = normalize(pathname).replace(/^([/\\])+/, "");
  let file = join(uiDir, clean === "" ? "index.html" : clean);
  if (!file.startsWith(uiDir)) return false;
  if (!(await exists(file)) || (await stat(file)).isDirectory()) {
    file = join(uiDir, "index.html"); // SPA fallback
    if (!(await exists(file))) return false;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
  return true;
}

// Reversible, collision-free path segment: percent-encode everything outside a safe set, and
// encode '.' too so a literal "feature/x" and "feature.x" / "feature_x" never map to one file.
function encodeSeg(s: string): string {
  return encodeURIComponent(s).replace(/\./g, "%2E").replace(/\*/g, "%2A");
}

// Coalesce concurrent misses for the same cache file so two runners racing one uncached ref
// share a single fetch (no duplicate download, no interleaved temp-file writes).
const inflightFetches = new Map<string, Promise<void>>();

/** GET /mirror/{owner}/{repo}/{tarball|zipball}/{ref} — serve from cache, else fetch and cache. */
async function serveMirror(pathname: string, res: http.ServerResponse, githubToken?: string): Promise<void> {
  const m = pathname.match(/^\/mirror\/([^/]+)\/([^/]+)\/(tarball|zipball)\/(.+)$/);
  if (!m) {
    res.writeHead(404);
    res.end("bad mirror path");
    return;
  }
  const [, owner, repo, kind, ref] = m;
  const file = join(ndhHome(), "mirror", encodeSeg(owner), encodeSeg(repo), `${kind}-${encodeSeg(ref)}.tgz`);
  if (!(await exists(file))) {
    try {
      let fetching = inflightFetches.get(file);
      if (!fetching) {
        fetching = fetchToCache(owner, repo, kind, ref, file, githubToken).finally(() => inflightFetches.delete(file));
        inflightFetches.set(file, fetching);
      }
      await fetching;
    } catch (err) {
      res.writeHead(502);
      res.end(`mirror fetch failed (offline and not cached?): ${err}`);
      return;
    }
  }
  res.writeHead(200, { "content-type": "application/octet-stream" });
  createReadStream(file).pipe(res);
}

async function fetchToCache(
  owner: string,
  repo: string,
  kind: string,
  ref: string,
  file: string,
  githubToken?: string,
): Promise<void> {
  // Upstream is overridable (NDH_MIRROR_UPSTREAM) so the mirror can point at a private GitHub
  // Enterprise host or a local fixture in tests; defaults to public GitHub.
  const upstream = process.env.NDH_MIRROR_UPSTREAM ?? "https://api.github.com";
  const src = `${upstream.replace(/\/$/, "")}/repos/${owner}/${repo}/${kind}/${ref}`;
  log(`mirror miss — fetching ${owner}/${repo}@${ref} (${kind})`);
  await mkdir(dirname(file), { recursive: true });
  const headers: Record<string, string> = { "user-agent": "notdownhub" };
  // `--github-token` (threaded here) or a shell-exported GITHUB_TOKEN authenticates the fetch.
  const token = githubToken ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `token ${token}`;
  await download(src, file, { headers });
}

export function uiDistDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "ui-dist");
}

/** Exposed for tests: the local-only UI access gates + the extracted request router. */
export const __test = { isLoopback, basicAuthOk, uiAccessAllowed, denyUi, isUiPath, handleRequest, encodeSeg };
