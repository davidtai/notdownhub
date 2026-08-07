import { spawnSync } from "node:child_process";
import { join } from "node:path";
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
  // Secret VALUES are passed only through the ephemeral --secret-file, never on argv.
  return withRunnerSecrets(slug, (sec) =>
    withRunnerVars(slug, (vars) =>
      runner(vendorExe("Runner.Client"), [...defaultPlatformArgs(argv), ...sec, ...vars, ...argv]),
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
  return withRunnerSecrets(slug, (sec) =>
    withRunnerVars(slug, (vars) => runner(vendorExe("Runner.Client"), [...sec, ...vars, ...argv])),
  );
}

/** Exported for tests. */
export const __test = { defaultPlatformArgs };
