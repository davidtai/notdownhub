import type { Command } from "commander";
import { downloadArtifact, listArtifacts } from "./artifacts.js";
import { fail, humanSize, log } from "./lib.js";

/** Default hub the artifact commands talk to when --server is omitted (the `ndh hub up` default). */
const DEFAULT_SERVER = "http://localhost:4949";

interface ArtifactsOptions {
  server: string;
  out?: string;
}

/** Trim a trailing slash so `${base}/_apis/...` never doubles up. */
function normalizeServer(server: string): string {
  return server.replace(/\/+$/, "");
}

/** `ndh artifacts <run-id>` — list a run's artifacts (name, size, id). */
export async function artifactsListCmd(runIdRaw: string, opts: ArtifactsOptions): Promise<number> {
  const runId = Number(runIdRaw);
  if (!Number.isInteger(runId) || runId <= 0) fail(`invalid run id '${runIdRaw}' — expected a positive integer`);
  const base = normalizeServer(opts.server);
  const artifacts = await listArtifacts(base, runId);
  if (artifacts.length === 0) {
    log(`run ${runId} has no artifacts`);
    return 0;
  }
  const nameW = Math.max(4, ...artifacts.map((a) => a.name.length));
  console.log(`${"NAME".padEnd(nameW)}  ${"SIZE".padStart(9)}  ID`);
  for (const a of artifacts) {
    console.log(`${a.name.padEnd(nameW)}  ${humanSize(a.size).padStart(9)}  ${a.id}`);
  }
  return 0;
}

/** `ndh artifacts download <run-id> <name> [--out dir]` — fetch an artifact's file(s) to disk. */
export async function artifactsDownloadCmd(runIdRaw: string, name: string, opts: ArtifactsOptions): Promise<number> {
  const runId = Number(runIdRaw);
  if (!Number.isInteger(runId) || runId <= 0) fail(`invalid run id '${runIdRaw}' — expected a positive integer`);
  const base = normalizeServer(opts.server);
  const outDir = opts.out ?? ".";
  const result = await downloadArtifact(base, runId, name, outDir);
  if (!result) fail(`no artifact '${name}' on run ${runId} (try: ndh artifacts ${runId} --server ${base})`);
  if (result.written.length === 0) {
    log(`artifact '${result.name}' has no files`);
    return 0;
  }
  for (const f of result.written) log(`downloaded ${f}`);
  return 0;
}

export function registerArtifacts(program: Command): void {
  const artifacts = program
    .command("artifacts")
    .description("list and download a run's artifacts from a hub")
    .argument("[run-id]", "the run id to list artifacts for (omit when using a subcommand)")
    .option("--server <url>", "hub base url", DEFAULT_SERVER)
    .option("--out <dir>", "directory to download into (download only)")
    .allowExcessArguments(false)
    .addHelpText(
      "after",
      `\nexamples:\n  ndh artifacts 7 --server http://hub:4949\n  ndh artifacts download 7 my-artifact --out ./dl --server http://hub:4949`,
    )
    .action(async (runId: string | undefined, opts: ArtifactsOptions, cmd: Command) => {
      // A bare `ndh artifacts` (no run id, no subcommand) is a usage error, matching the others.
      if (!runId) {
        cmd.help({ error: true });
        return;
      }
      process.exitCode = await artifactsListCmd(runId, opts);
    });

  artifacts
    .command("download")
    .description("download an artifact's file(s) to disk")
    .argument("<run-id>", "the run id")
    .argument("<name>", "the artifact name (or its numeric id)")
    .option("--server <url>", "hub base url", DEFAULT_SERVER)
    .option("--out <dir>", "directory to download into (default: current directory)")
    .action(async (runId: string, name: string, opts: ArtifactsOptions) => {
      process.exitCode = await artifactsDownloadCmd(runId, name, opts);
    });
}

/** Exposed for tests. */
export const __test = { normalizeServer, DEFAULT_SERVER };
