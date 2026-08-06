import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, stat, readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { download, exists, log, ndhHome } from "./lib.js";

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
export function startFront(opts: FrontOptions): http.Server {
  const mint = managementJwt(opts.hubPort, opts.runnerToken);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/mirror/")) {
        await serveMirror(url.pathname, res);
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
  });
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

async function serveUi(uiDir: string, pathname: string, res: http.ServerResponse): Promise<boolean> {
  // Reserve API-ish prefixes for the hub proxy.
  if (pathname.startsWith("/_apis/") || pathname.startsWith("/runner/") || pathname.startsWith("/api/")) return false;
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
    const src = `https://api.github.com/repos/${owner}/${repo}/${kind}/${ref}`;
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
