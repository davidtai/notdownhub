import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import { unwrap } from "./lib.js";

/**
 * Artifact retrieval. The hub already stores uploaded artifacts (ArtifactRecords /
 * ArtifactFileContainer tables + blob storage) and serves them over the engine's v3
 * pipelines API — which is AllowAnonymous and therefore reaches through the ndh front
 * proxy untouched:
 *   GET /_apis/pipelines/workflows/{run}/artifacts        list a run's artifacts
 *   GET /_apis/pipelines/workflows/container/{id}         list the files in one artifact
 *   GET /_apis/pipelines/workflows/artifact/{id}?file=…   the file bytes
 * An actions/upload-artifact@v4 upload lands as a single `<name>.zip` archive in the
 * container (exactly what GitHub's own web download hands back). This module turns those
 * raw endpoints into: a run's artifact list (with real sizes — the list endpoint reports
 * 0), a UI-served archive download, and a CLI download to disk. Everything degrades to an
 * empty list / null rather than throwing, so a run with no artifacts is a clean no-op.
 */

export interface ArtifactInfo {
  /** Container id — the id used to download this artifact. */
  id: number;
  name: string;
  /** Total archive size in bytes (summed from the container's files). */
  size: number;
}

export interface ArtifactFile {
  path: string;
  size: number;
}

interface RawContainer {
  containerId?: number;
  name?: string;
  size?: number;
}

interface RawFile {
  path?: string;
  fileLength?: number;
  itemType?: string;
}

const listUrl = (base: string, runId: number): string => `${base}/_apis/pipelines/workflows/${runId}/artifacts`;
const filesUrl = (base: string, id: number): string => `${base}/_apis/pipelines/workflows/container/${id}`;
const fileUrl = (base: string, id: number, path: string): string =>
  `${base}/_apis/pipelines/workflows/artifact/${id}?file=${encodeURIComponent(path)}`;

/** The concrete files inside one artifact container (folders filtered out). Empty on any error. */
export async function fetchContainerFiles(base: string, id: number): Promise<ArtifactFile[]> {
  try {
    const res = await fetch(filesUrl(base, id));
    if (!res.ok) return [];
    return unwrap<RawFile>(await res.json())
      .filter((f) => f.itemType !== "folder" && !!f.path)
      .map((f) => ({ path: f.path!, size: f.fileLength ?? 0 }));
  } catch {
    return [];
  }
}

async function fetchContainers(base: string, runId: number): Promise<RawContainer[]> {
  const res = await fetch(listUrl(base, runId));
  if (!res.ok) return [];
  return unwrap<RawContainer>(await res.json()).filter((c) => typeof c.containerId === "number" && !!c.name);
}

/** A run's artifacts with real sizes. Returns [] for a run with no artifacts (or any error). */
export async function listArtifacts(base: string, runId: number): Promise<ArtifactInfo[]> {
  let containers: RawContainer[];
  try {
    containers = await fetchContainers(base, runId);
  } catch {
    return [];
  }
  const out: ArtifactInfo[] = [];
  for (const c of containers) {
    // The list endpoint reports size 0 for v4 uploads; sum the container's file lengths instead.
    let size = c.size ?? 0;
    if (!size) size = (await fetchContainerFiles(base, c.containerId!)).reduce((n, f) => n + f.size, 0);
    out.push({ id: c.containerId!, name: c.name!, size });
  }
  return out;
}

export interface ResolvedArtifact {
  id: number;
  name: string;
  files: ArtifactFile[];
}

/** Find a run's artifact by exact name or numeric container id; null if the run has no such artifact. */
export async function resolveArtifact(base: string, runId: number, selector: string): Promise<ResolvedArtifact | null> {
  let containers: RawContainer[];
  try {
    containers = await fetchContainers(base, runId);
  } catch {
    return null;
  }
  const asId = Number(selector);
  const match =
    containers.find((c) => c.name === selector) ??
    (Number.isInteger(asId) ? containers.find((c) => c.containerId === asId) : undefined);
  if (!match) return null;
  return { id: match.containerId!, name: match.name!, files: await fetchContainerFiles(base, match.containerId!) };
}

/** The single downloadable archive of an artifact (the `<name>.zip`, else the first file). */
function archiveFile(art: ResolvedArtifact): ArtifactFile | null {
  if (art.files.length === 0) return null;
  return art.files.find((f) => f.path.toLowerCase().endsWith(".zip")) ?? art.files[0];
}

/**
 * Stream a run artifact's archive to `res` for a UI download (Content-Disposition attachment).
 * 404 (JSON) when the run has no such artifact, 502 if the upstream blob read fails.
 */
export async function serveArtifactDownload(
  base: string,
  runId: number,
  selector: string,
  res: ServerResponse,
): Promise<void> {
  const art = await resolveArtifact(base, runId, selector);
  const file = art && archiveFile(art);
  if (!art || !file) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `no artifact '${selector}' on run ${runId}` }));
    return;
  }
  let upstream: Response;
  try {
    upstream = await fetch(fileUrl(base, art.id, file.path));
  } catch {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "artifact storage unreachable" }));
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `artifact storage returned ${upstream.status}` }));
    return;
  }
  const filename = basename(file.path).replace(/"/g, "");
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": String(file.size),
    "content-disposition": `attachment; filename="${filename}"`,
  });
  await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream), res);
}

export interface DownloadResult {
  name: string;
  written: string[];
}

/**
 * Download a run artifact's file(s) into `outDir` (paths preserved), for the CLI. Returns the
 * artifact name + the files written, or null when the run has no such artifact.
 */
export async function downloadArtifact(
  base: string,
  runId: number,
  selector: string,
  outDir: string,
): Promise<DownloadResult | null> {
  const art = await resolveArtifact(base, runId, selector);
  if (!art) return null;
  const written: string[] = [];
  for (const f of art.files) {
    const dest = join(outDir, f.path);
    await mkdir(dirname(dest), { recursive: true });
    const upstream = await fetch(fileUrl(base, art.id, f.path));
    if (!upstream.ok || !upstream.body) throw new Error(`download failed for ${f.path}: ${upstream.status} ${upstream.statusText}`);
    await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream), createWriteStream(dest));
    written.push(dest);
  }
  return { name: art.name, written };
}

/** Match the URL actions/upload-artifact prints — `/{owner}/{repo}/actions/runs/{run}/artifacts/{id}`. */
export function parseArtifactPrettyUrl(pathname: string): { runId: number; artifactId: string } | null {
  const m = pathname.match(/^\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/artifacts\/(\d+)\/?$/);
  if (!m) return null;
  return { runId: Number(m[1]), artifactId: m[2] };
}

/** Match a `/api/local/artifacts/{run}` list or `/api/local/artifacts/{run}/{selector}` download path. */
export function parseArtifactApiPath(pathname: string): { runId: number; selector: string | null } | null {
  const m = pathname.match(/^\/api\/local\/artifacts\/(\d+)(?:\/(.+?))?\/?$/);
  if (!m) return null;
  return { runId: Number(m[1]), selector: m[2] ? decodeURIComponent(m[2]) : null };
}
