import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { ensureVendor } from "./vendor.js";
import { hubProbeAmbiguousMessage, hubUnreachableMessage, isDefinitiveDown, log, ndhHome, probeServer, run, vendorExe, type Reachability } from "./lib.js";
import { initFileLog } from "./filelog.js";
import { currentRepoSlug, withRunnerSecrets } from "./secrets.js";
import { withRunnerVars } from "./vars.js";
import { HOSTED_LABELS } from "./platform.js";

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

/**
 * Default runs-on mappings for the one-shot local `ndh run`: hosted labels run on this machine
 * (or in docker for linux images when available). The label list is shared with the hub-side
 * default mapping (platform.ts / rerunmap.ts) so client and hub can never drift apart.
 */
function defaultPlatformArgs(argv: string[], docker: () => boolean = dockerAvailable): string[] {
  if (argv.includes("-P") || argv.includes("--platform")) return [];
  const linuxTarget = docker() ? "catthehacker/ubuntu:act-latest" : "-self-hosted";
  return [
    "-P", "self-hosted=-self-hosted",
    ...HOSTED_LABELS.flatMap((label) => ["-P", `${label}=${label.startsWith("ubuntu-") ? linuxTarget : "-self-hosted"}`]),
  ];
}

/**
 * The project every run belongs to, as `owner/repo`. Prefer the checkout's origin
 * remote (already resolved for secrets scoping); when there is none, fall back to
 * `local/<dirname>`. The engine records `github.repository` verbatim and derives
 * the owner by splitting on "/", so a bare, ownerless value renders as
 * `Unknown/Unknown` — the fallback is deliberately a two-part slug so a run never
 * shows up as "Unknown" (verified against the vendored Runner.Client).
 */
export function projectSlug(originSlug: string | null, cwd: string = process.cwd()): string {
  if (originSlug) return originSlug;
  const dir = basename(cwd).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `local/${dir || "workspace"}`;
}

/**
 * Inject `--repository <slug>` unless the user already passed one (theirs always
 * wins). Returned as an argv prefix so it precedes the user's own arguments.
 */
export function repositoryArgs(argv: string[], slug: string): string[] {
  if (argv.some((a) => a === "--repository" || a.startsWith("--repository="))) return [];
  return ["--repository", slug];
}

/** The value of `--server <url>` / `--server=<url>` in an argv, or null when absent. */
export function serverArg(argv: string[]): string | null {
  const i = argv.indexOf("--server");
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith("--server="));
  return eq ? eq.slice("--server=".length) : null;
}

/** Seams so tests can observe the exact Runner.Client argv without spawning it. */
export interface RunDeps {
  runner?: (cmd: string, args: string[]) => Promise<number>;
  ensure?: () => Promise<unknown>;
  repoSlug?: () => string | null;
  /** Pre-flight hub reachability check (dispatch). Defaults to a real network probe. */
  probe?: (url: string) => Promise<Reachability>;
}

/** `ndh run` — one-shot: in-process hub + runner, executes this repo's workflows right here. */
export async function runCmd(argv: string[], deps: RunDeps = {}): Promise<number> {
  const runner = deps.runner ?? run;
  if (!deps.runner) initFileLog(join(ndhHome(), "logs"), "run");
  await (deps.ensure ?? ensureVendor)();
  const slug = (deps.repoSlug ?? currentRepoSlug)();
  const repo = repositoryArgs(argv, projectSlug(slug));
  // Secret VALUES are passed only through the ephemeral --secret-file, never on argv.
  return withRunnerSecrets(slug, (sec) =>
    withRunnerVars(slug, (vars) =>
      runner(vendorExe("Runner.Client"), [...defaultPlatformArgs(argv), ...sec, ...vars, ...repo, ...argv]),
    ),
  );
}

/** `ndh dispatch --server <hub>` — ship this repo's workflows to a hub for the fleet to run. */
export async function dispatchCmd(argv: string[], deps: RunDeps = {}): Promise<number> {
  const runner = deps.runner ?? run;
  if (!deps.runner) initFileLog(join(ndhHome(), "logs"), "dispatch");
  await (deps.ensure ?? ensureVendor)();
  const server = serverArg(argv);
  if (!server) {
    console.error("usage: ndh dispatch --server http://hub:4949 [Runner.Client args...]");
    return 2;
  }
  // Pre-flight: a definitively-down hub (down / wrong port / wrong --server) is the single most
  // common dispatch failure (#69). Catch it here and print one actionable [ndh] line instead of
  // leaking Runner.Client's raw "Exception: Connection refused". The underlying error follows.
  //
  // But a live hub can transiently reset or answer slowly (#85), so only DEFINITIVE-down codes
  // hard-block. An AMBIGUOUS probe result (reset/timeout) warns and proceeds to the real dispatch,
  // which either works or surfaces its own precise error — no false-block on a hub that is up.
  const reach = await (deps.probe ?? probeServer)(server);
  if (!reach.ok) {
    if (isDefinitiveDown(reach.code)) {
      log(hubUnreachableMessage(server));
      if (reach.detail) log(`  ${reach.detail}`);
      return 1;
    }
    log(hubProbeAmbiguousMessage(server));
    if (reach.detail) log(`  ${reach.detail}`);
  }
  const slug = (deps.repoSlug ?? currentRepoSlug)();
  const repo = repositoryArgs(argv, projectSlug(slug));
  return withRunnerSecrets(slug, (sec) =>
    withRunnerVars(slug, (vars) => runner(vendorExe("Runner.Client"), [...sec, ...vars, ...repo, ...argv])),
  );
}

/** Exported for tests. */
export const __test = { defaultPlatformArgs, projectSlug, repositoryArgs, serverArg };
