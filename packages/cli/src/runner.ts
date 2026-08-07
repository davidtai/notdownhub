import type { Command } from "commander";
import { cp, mkdir, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { SpawnOptions } from "node:child_process";
import { ensureVendor } from "./vendor.js";
import { exists, fail, log, ndhHome, run, vendorDir } from "./lib.js";
import { initFileLog } from "./filelog.js";

function runnerDir(name: string): string {
  return join(ndhHome(), "runners", name);
}

// The bundle acts as the runner's bin/ dir; the listener writes .runner/.credentials to
// bin's parent, so each instance gets its own <name>/ root with the bundle nested inside.
function listenerExe(dir: string): string {
  return join(dir, "bin", process.platform === "win32" ? "Runner.Listener.exe" : "Runner.Listener");
}

const defaultName = () => `${hostname()}-ndh`;
const defaultLabels = () =>
  `self-hosted,${process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux"},${process.arch === "arm64" ? "ARM64" : "X64"}`;

interface JoinOptions {
  name: string;
  labels: string;
  token: string;
}

/**
 * Injectable seams so the join/start orchestration (per-runner dir layout, URL normalization,
 * configure argv) is testable without the vendored listener binary or a 200MB copy.
 */
export interface RunnerDeps {
  ensure?: () => Promise<unknown>;
  run?: (cmd: string, args: string[], opts?: SpawnOptions) => Promise<number>;
  copyVendor?: (dir: string) => Promise<void>;
}

export function registerRunner(program: Command): void {
  const runner = program
    .command("runner")
    .description("register and run self-hosted runners against a hub")
    .action(() => {
      // `ndh runner` with no subcommand — matches the original usage error + exit code.
      console.error(
        "usage: ndh runner join <hub-url> [--name n] [--labels a,b] [--token t]\n       ndh runner start [name]\n       ndh runner list",
      );
      process.exitCode = 2;
    });

  runner
    .command("join")
    .description("register this machine as a runner (works across NAT)")
    .argument("<hub-url>", "hub base url, e.g. http://hub.local:4949")
    .option("--name <name>", "runner name", defaultName())
    .option("--labels <labels>", "comma-separated runner labels", defaultLabels())
    .option("--token <token>", "hub registration token", "notdownhub")
    .action(async (hubUrl: string, opts: JoinOptions) => {
      process.exitCode = await join_(hubUrl, opts);
    });

  runner
    .command("start")
    .description("start a joined runner (defaults to the only one if unambiguous)")
    .argument("[name]", "runner name")
    .action(async (name?: string) => {
      process.exitCode = await start(name);
    });

  runner
    .command("list")
    .description("list joined runners")
    .action(async () => {
      process.exitCode = await list();
    });
}

async function defaultCopyVendor(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await cp(vendorDir(), join(dir, "bin"), { recursive: true });
}

async function join_(hubUrl: string, opts: JoinOptions, deps: RunnerDeps = {}): Promise<number> {
  await (deps.ensure ?? ensureVendor)();
  const runner = deps.run ?? run;

  // Each runner needs its own directory: the listener stores .runner/.credentials beside its binary.
  const dir = runnerDir(opts.name);
  if (!(await exists(listenerExe(dir)))) {
    log(`preparing runner instance at ${dir} ...`);
    await (deps.copyVendor ?? defaultCopyVendor)(dir);
  }
  const url = new URL("runner/server", hubUrl.endsWith("/") ? hubUrl : `${hubUrl}/`).toString();
  const code = await runner(
    listenerExe(dir),
    [
      "configure", "--unattended",
      "--url", url,
      "--token", opts.token,
      "--name", opts.name,
      "--labels", opts.labels,
      "--work", "_work",
      "--replace",
    ],
    { cwd: dir },
  );
  if (code !== 0) return code;
  log(`runner '${opts.name}' joined ${hubUrl}`);
  log(`start it: ndh runner start ${opts.name}`);
  return 0;
}

async function start(name?: string, deps: RunnerDeps = {}): Promise<number> {
  const runner = deps.run ?? run;
  if (!name) {
    const runners = await listNames();
    if (runners.length !== 1) fail(`specify which runner: ${runners.join(", ") || "(none joined yet)"}`);
    name = runners[0];
  }
  const dir = runnerDir(name);
  if (!(await exists(listenerExe(dir)))) fail(`runner '${name}' not found — join a hub first`);
  log(`logging to ${initFileLog(join(dir, "logs"), "runner")} (daily rotation)`);
  log(`runner '${name}' listening for jobs (ctrl-c to stop)`);
  return runner(listenerExe(dir), ["run"], { cwd: dir });
}

async function listNames(): Promise<string[]> {
  try {
    return await readdir(join(ndhHome(), "runners"));
  } catch {
    return [];
  }
}

async function list(): Promise<number> {
  for (const n of await listNames()) console.log(n);
  return 0;
}

/** Exposed for tests. */
export const __test = { join_, start, listenerExe, defaultName, defaultLabels };
