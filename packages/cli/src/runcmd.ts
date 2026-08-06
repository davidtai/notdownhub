import { spawnSync } from "node:child_process";
import { ensureVendor } from "./vendor.js";
import { run, vendorExe } from "./lib.js";

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

/** Default runs-on mappings: hosted labels run on this machine (or in docker for linux images when available). */
function defaultPlatformArgs(argv: string[]): string[] {
  if (argv.includes("-P") || argv.includes("--platform")) return [];
  const linuxTarget = dockerAvailable() ? "catthehacker/ubuntu:act-latest" : "-self-hosted";
  return [
    "-P", "self-hosted=-self-hosted",
    "-P", `ubuntu-latest=${linuxTarget}`,
    "-P", `ubuntu-24.04=${linuxTarget}`,
    "-P", `ubuntu-22.04=${linuxTarget}`,
    "-P", "macos-latest=-self-hosted",
    "-P", "windows-latest=-self-hosted",
  ];
}

/** `ndh run` — one-shot: in-process hub + runner, executes this repo's workflows right here. */
export async function runCmd(argv: string[]): Promise<number> {
  await ensureVendor();
  return run(vendorExe("Runner.Client"), [...defaultPlatformArgs(argv), ...argv]);
}

/** `ndh dispatch --server <hub>` — ship this repo's workflows to a hub for the fleet to run. */
export async function dispatchCmd(argv: string[]): Promise<number> {
  await ensureVendor();
  if (!argv.includes("--server")) {
    console.error("usage: ndh dispatch --server http://hub:4949 [Runner.Client args...]");
    return 2;
  }
  return run(vendorExe("Runner.Client"), argv);
}
