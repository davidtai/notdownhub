import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { ensureVendor } from "./vendor.js";
import { ndhHome, run, vendorExe } from "./lib.js";
import { initFileLog } from "./filelog.js";
import { currentRepoSlug, withRunnerSecrets } from "./secrets.js";
import { withRunnerVars } from "./vars.js";

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

/** Default runs-on mappings: hosted labels run on this machine (or in docker for linux images when available). */
function defaultPlatformArgs(argv: string[], docker: () => boolean = dockerAvailable): string[] {
  if (argv.includes("-P") || argv.includes("--platform")) return [];
  const linuxTarget = docker() ? "catthehacker/ubuntu:act-latest" : "-self-hosted";
  return [
    "-P", "self-hosted=-self-hosted",
    "-P", `ubuntu-latest=${linuxTarget}`,
    "-P", `ubuntu-24.04=${linuxTarget}`,
    "-P", `ubuntu-22.04=${linuxTarget}`,
    "-P", "macos-latest=-self-hosted",
    "-P", "windows-latest=-self-hosted",
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

/** Seams so tests can observe the exact Runner.Client argv without spawning it. */
export interface RunDeps {
  runner?: (cmd: string, args: string[]) => Promise<number>;
  ensure?: () => Promise<unknown>;
  repoSlug?: () => string | null;
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
  if (!argv.some((a) => a === "--server" || a.startsWith("--server="))) {
    console.error("usage: ndh dispatch --server http://hub:4949 [Runner.Client args...]");
    return 2;
  }
  const slug = (deps.repoSlug ?? currentRepoSlug)();
  const repo = repositoryArgs(argv, projectSlug(slug));
  return withRunnerSecrets(slug, (sec) =>
    withRunnerVars(slug, (vars) => runner(vendorExe("Runner.Client"), [...sec, ...vars, ...repo, ...argv])),
  );
}

/** Exported for tests. */
export const __test = { defaultPlatformArgs, projectSlug, repositoryArgs };
