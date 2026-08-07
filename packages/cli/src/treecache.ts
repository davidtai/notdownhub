/**
 * Per-run retention of the dispatched working tree (issue #110).
 *
 * A local dispatch's checkout streams the dispatching machine's tree through the engine:
 * the runner GETs `/_apis/v1/Message/multipart/<runid>`, the engine round-trips that to the
 * Runner.Client still attached to the dispatch's schedule2 SSE feed, and the client uploads
 * the tree. The engine STORES NOTHING — once the dispatch client exits, that endpoint hangs
 * forever (GetMulti has no timeout), so a re-run attempt could never check out again.
 *
 * Every runner reaches the engine THROUGH the ndh front (the hub mints ACTIONS_RUNTIME_URL
 * from the Host header — the same #34/#107 always-proxy fact). So the front:
 *   1. tees the tree to disk the first time it streams past (the original attempt's checkout),
 *      keyed by runid + the request shape (submodules/nestedSubmodules/repositoryAndRef);
 *   2. serves later requests for the same shape straight from that cache — which is exactly
 *      what a replayed re-run attempt's checkout does after the dispatch client is long gone.
 *
 * A cache entry is complete only when its meta file exists (data renamed first, meta written
 * last); a stream that dies mid-tee leaves a discarded temp file, never a half tree. The
 * engine serves this endpoint anonymously (runners fetch it with no auth header), so serving
 * the cached bytes on the same route grants nothing new.
 */
import http from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log, ndhHome } from "./lib.js";

/** Retained trees live beside the hub's other durable state. */
export function treeCacheDir(): string {
  return join(ndhHome(), "hub", "treecache");
}

/** Reversible, collision-free file segment (same discipline as the mirror's encodeSeg). */
function seg(s: string): string {
  return encodeURIComponent(s).replace(/\./g, "%2E").replace(/\*/g, "%2A");
}

/**
 * Stable cache key for one request shape. The inner action always sends submodules and
 * nestedSubmodules explicitly; repositoryAndRef appears only for foreign `repo@ref` fetches.
 */
export function treeKey(params: URLSearchParams): string {
  const flag = (v: string | null) => (v === "true" ? "true" : "false");
  return [
    `submodules=${flag(params.get("submodules"))}`,
    `nested=${flag(params.get("nestedSubmodules"))}`,
    `repo=${seg(params.get("repositoryAndRef") ?? "")}`,
  ].join("&");
}

interface TreeMeta {
  contentType: string;
}

/** True when at least one complete tree (data + meta marker) is retained for the run. */
export async function hasCompleteTree(runId: number): Promise<boolean> {
  try {
    const names = await readdir(join(treeCacheDir(), String(runId)));
    return names.some((n) => n.endsWith(".json") && names.includes(`${n.slice(0, -5)}.multipart`));
  } catch {
    return false;
  }
}

/**
 * Serve a retained tree for GET .../multipart/<runid>. Returns false — with nothing written —
 * when no complete entry matches the request shape, so the caller proxies (and tees) instead.
 */
export async function serveTree(
  runId: number,
  params: URLSearchParams,
  res: http.ServerResponse,
): Promise<boolean> {
  const dir = join(treeCacheDir(), String(runId));
  const key = treeKey(params);
  try {
    const meta = JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as TreeMeta;
    const data = join(dir, `${key}.multipart`);
    const size = (await stat(data)).size;
    if (!meta.contentType) return false;
    res.writeHead(200, { "content-type": meta.contentType, "content-length": size });
    await new Promise<void>((resolve) => {
      const rs = createReadStream(data);
      rs.on("error", () => {
        res.destroy();
        resolve();
      });
      res.on("close", resolve);
      rs.pipe(res);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Proxy GET .../multipart/<runid> to the engine and tee a 200 stream into the cache.
 * Proxy semantics match front.proxy (Host passthrough, abort upstream when the client goes
 * away); the tee finalizes only on a clean upstream end — data renamed into place first,
 * meta marker written last.
 */
export async function proxyRetainTree(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hubPort: number,
  runId: number,
  params: URLSearchParams,
): Promise<void> {
  const dir = join(treeCacheDir(), String(runId));
  const key = treeKey(params);
  await mkdir(dir, { recursive: true }).catch(() => {});
  const upstream = http.request(
    { host: "127.0.0.1", port: hubPort, path: req.url, method: "GET", headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      res.flushHeaders?.();
      const contentType = String(up.headers["content-type"] ?? "");
      if (up.statusCode === 200 && contentType) {
        // Tee into a temp file and END THE RESPONSE ONLY AFTER the cache finalized — so the
        // moment a consumer sees its GET complete, hasCompleteTree is already true. A tee
        // failure (disk) never breaks the consumer's stream: the pipe auto-unpipes the dead
        // sink, the temp file is discarded, and the response still ends normally.
        const tmp = join(dir, `.${key}.${randomUUID()}.part`);
        const ws = createWriteStream(tmp);
        let dead = false;
        let upEnded = false;
        const finishRes = () => {
          if (!res.writableEnded && !res.destroyed) res.end();
        };
        const discard = () => {
          if (!dead) {
            dead = true;
            ws.destroy();
            void rm(tmp, { force: true }).catch(() => {});
          }
          if (upEnded) finishRes();
        };
        ws.on("error", discard);
        up.on("error", () => {
          discard();
          res.destroy();
        });
        up.on("aborted", () => {
          discard();
          res.destroy();
        });
        up.on("end", () => {
          upEnded = true;
          if (dead) {
            finishRes();
            return;
          }
          ws.end(() => {
            void finalize(dir, key, tmp, contentType).finally(finishRes);
          });
        });
        up.pipe(ws, { end: false });
        up.pipe(res, { end: false });
      } else {
        up.pipe(res);
        up.on("error", () => res.destroy());
        up.on("aborted", () => res.destroy());
      }
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("hub unavailable");
    } else {
      res.destroy();
    }
  });
  const abort = () => upstream.destroy();
  res.on("close", abort);
  req.on("aborted", abort);
  req.pipe(upstream);
}

/** Data into place first, meta marker last — a crash between the two leaves "incomplete". */
async function finalize(dir: string, key: string, tmp: string, contentType: string): Promise<void> {
  try {
    await rename(tmp, join(dir, `${key}.multipart`));
    await writeFile(join(dir, `${key}.json`), JSON.stringify({ contentType } satisfies TreeMeta));
    log(`retained the dispatched tree for run at ${dir} (${key})`);
  } catch (err) {
    log(`tree retention failed (re-runs of this run will need a re-dispatch): ${String(err)}`);
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Serve from the cache when complete, else proxy through the engine and retain the stream. */
export async function serveOrRetainTree(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hubPort: number,
  runId: number,
  params: URLSearchParams,
): Promise<void> {
  if (await serveTree(runId, params, res)) return;
  await proxyRetainTree(req, res, hubPort, runId, params);
}

/** Drop the retained trees of one run (used when a run is deleted/pruned). */
export async function dropTree(runId: number): Promise<void> {
  await rm(join(treeCacheDir(), String(runId)), { recursive: true, force: true }).catch(() => {});
}
