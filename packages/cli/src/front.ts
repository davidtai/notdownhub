import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { download, exists, log, ndhHome } from "./lib.js";
import { getAgentsInfo } from "./agents-info.js";
import { serveJobLogs } from "./joblogs.js";
import { getConfigInfo } from "./config-info.js";

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
function managementJwt(hubPort: number, runnerToken: string | undefined) {
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
    if (url.pathname.startsWith("/mirror/")) {
      await serveMirror(url.pathname, res);
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
    } else if (url.pathname === "/api/local/joblogs" || url.pathname.startsWith("/api/local/joblogs/")) {
      // Persisted console output for a completed run's job (survives hub restarts).
      if (!uiAccessAllowed(req, opts)) {
        denyUi(res, opts);
        return;
      }
      await serveJobLogs(url.pathname, res);
    } else if (opts.uiDir && !uiAccessAllowed(req, opts) && isUiPath(url.pathname)) {
      denyUi(res, opts);
    } else if (opts.uiDir && (await serveUi(opts.uiDir, url.pathname, res))) {
      // served static UI
    } else {
      // Status APIs (agents/pools) demand a management JWT even for reads; grant it to
      // anonymous GETs only, so the UI can render runner status without holding secrets.
      let bearer: string | null = null;
      if (req.method === "GET" && !req.headers.authorization && /^\/_apis\/v1\/Agent(Pools)?\//i.test(url.pathname + "/")) {
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
  const server = http.createServer((req, res) => handleRequest(req, res, opts, mint));
  // Runner protocol long-polls (~50s holds); never kill slow requests.
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  server.listen(opts.port);
  return server;
}

function proxy(req: http.IncomingMessage, res: http.ServerResponse, hubPort: number, bearer: string | null = null): void {
  const headers = bearer ? { ...req.headers, authorization: `Bearer ${bearer}` } : req.headers;
  const upstream = http.request(
    // Host header passes through untouched: the hub mints runner tenant URLs from it,
    // so it must stay the public-facing host:port, not the internal one.
    { host: "127.0.0.1", port: hubPort, path: req.url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("hub unavailable");
  });
  req.pipe(upstream);
}

/** Paths the static UI would serve — everything except the hub-proxy and mirror prefixes. */
function isUiPath(pathname: string): boolean {
  return !(
    pathname.startsWith("/_apis/") ||
    pathname.startsWith("/runner/") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/mirror/")
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

/** GET /mirror/{owner}/{repo}/{tarball|zipball}/{ref} — serve from cache, else fetch from GitHub and cache. */
async function serveMirror(pathname: string, res: http.ServerResponse): Promise<void> {
  const m = pathname.match(/^\/mirror\/([^/]+)\/([^/]+)\/(tarball|zipball)\/(.+)$/);
  if (!m) {
    res.writeHead(404);
    res.end("bad mirror path");
    return;
  }
  const [, owner, repo, kind, ref] = m;
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  const file = join(ndhHome(), "mirror", safe(owner), safe(repo), `${kind}-${safe(ref)}.tgz`);
  if (!(await exists(file))) {
    // Upstream is overridable (NDH_MIRROR_UPSTREAM) so the mirror can point at a private GitHub
    // Enterprise host or a local fixture in tests; defaults to public GitHub.
    const upstream = process.env.NDH_MIRROR_UPSTREAM ?? "https://api.github.com";
    const src = `${upstream.replace(/\/$/, "")}/repos/${owner}/${repo}/${kind}/${ref}`;
    log(`mirror miss — fetching ${owner}/${repo}@${ref} (${kind})`);
    await mkdir(dirname(file), { recursive: true });
    const headers: Record<string, string> = { "user-agent": "notdownhub" };
    if (process.env.GITHUB_TOKEN) headers.authorization = `token ${process.env.GITHUB_TOKEN}`;
    try {
      await download(src, file, { headers });
    } catch (err) {
      res.writeHead(502);
      res.end(`mirror fetch failed (offline and not cached?): ${err}`);
      return;
    }
  }
  res.writeHead(200, { "content-type": "application/octet-stream" });
  createReadStream(file).pipe(res);
}

export function uiDistDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "ui-dist");
}

/** Exposed for tests: the local-only UI access gates + the extracted request router. */
export const __test = { isLoopback, basicAuthOk, uiAccessAllowed, denyUi, isUiPath, handleRequest };
