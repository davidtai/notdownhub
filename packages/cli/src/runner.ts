import type { Command } from "commander";
import { cp, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import { ensureVendor } from "./vendor.js";
import { connErrorCode, exists, fail, hubUnreachableMessage, log, ndhHome, rootErrorMessage, run, vendorDir } from "./lib.js";
import { initFileLog } from "./filelog.js";
import { getFleet, stateLabel, type Fleet } from "./fleet.js";

/** Default registration token — the literal used when no hub-issued token is supplied (open hubs). */
const DEFAULT_TOKEN = "notdownhub";
/** Bound the listener's hub round-trip on `remove` so an unreachable hub can't hang the command. */
const REMOVE_TIMEOUT_MS = 30_000;
/** Graceful-stop window for a running listener before SIGKILL. */
const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 200;

function runnerDir(name: string): string {
  return join(ndhHome(), "runners", name);
}

// The bundle acts as the runner's bin/ dir; the listener writes .runner/.credentials to
// bin's parent, so each instance gets its own <name>/ root with the bundle nested inside.
function caPath(dir: string): string {
  return join(dir, "ca.pem");
}

/** Env for listener spawns: trust the stored hub certificate when one exists. */
async function listenerEnv(dir: string): Promise<NodeJS.ProcessEnv> {
  const ca = caPath(dir);
  if (!(await exists(ca))) return { ...process.env };
  return { ...process.env, SSL_CERT_FILE: ca, NODE_EXTRA_CA_CERTS: ca };
}

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
  ca?: string;
  reJoin?: boolean;
}

/**
 * Injectable seams so the join/start orchestration (per-runner dir layout, URL normalization,
 * configure argv) is testable without the vendored listener binary or a 200MB copy.
 */
export interface RunnerDeps {
  ensure?: () => Promise<unknown>;
  run?: (cmd: string, args: string[], opts?: SpawnOptions) => Promise<number>;
  copyVendor?: (dir: string) => Promise<void>;
  /** Find the pids of the listener process(es) for an instance (matched by its dir in the command line). */
  findListener?: (dir: string) => Promise<number[]>;
  /** Send a signal to a pid (signal 0 = liveness probe). */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Run the vendored listener's `remove` in the instance dir; resolves its exit code (0 = unregistered). */
  removeExec?: (dir: string, token: string) => Promise<number>;
  /** Resolve the registration token used to unregister (mirrors join's token flow). */
  token?: (opts: RemoveOptions) => Promise<string>;
  /** Sleep between graceful-stop polls (injected so tests don't wait on real time). */
  delay?: (ms: number) => Promise<void>;
}

interface RemoveOptions {
  token: string;
  force?: boolean;
}

export function registerRunner(program: Command): void {
  const runner = program
    .command("runner")
    .description("register and run self-hosted runners against a hub")
    .action(() => {
      // `ndh runner` with no subcommand — matches the original usage error + exit code.
      console.error(
        "usage: ndh runner join <hub-url> [--name n] [--labels a,b] [--token t] [--re-join]\n       ndh runner start [name]\n       ndh runner list\n       ndh runner remove <name> [--token t] [--force]",
      );
      process.exitCode = 2;
    });

  runner
    .command("join")
    .description("register this machine as a runner (works across NAT)")
    .argument("<hub-url>", "hub base url, e.g. http://hub.local:4949")
    .option("--name <name>", "runner name", defaultName())
    .option("--labels <labels>", "comma-separated runner labels", defaultLabels())
    .option("--token <token>", "hub registration token", DEFAULT_TOKEN)
    .option("--ca <pem>", "trust this certificate for a --tls hub (stored with the runner)")
    .option("--re-join", "refresh an existing runner: unregister it, re-copy the bundle, then configure fresh")
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
    .description("list joined runners (this machine), or the hub's fleet with --server")
    .option("--server <url>", "show the hub's fleet (labels + live state) instead of local instances")
    .action(async (opts: { server?: string }) => {
      process.exitCode = await list(opts);
    });

  runner
    .command("remove")
    .description("stop, unregister from the hub, and delete a joined runner instance")
    .argument("<name>", "runner name")
    .option("--token <token>", "hub registration token used to unregister the agent", DEFAULT_TOKEN)
    .option("--force", "skip the hub unregister step (offline removal)")
    .action(async (name: string, opts: { token: string; force?: boolean }) => {
      process.exitCode = await remove_(name, opts);
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
  const alreadyJoined = await exists(listenerExe(dir));

  // Re-joining an existing name is destructive (it unregisters the old identity and overwrites the
  // bundle), so it must be explicit. Without --re-join, refuse cleanly instead of letting the
  // vendored `configure` bail out with its raw "already configured … run config.sh remove" error.
  if (alreadyJoined && !opts.reJoin) {
    log(`runner '${opts.name}' is already joined (instance at ${dir})`);
    log(
      `to refresh it (re-register + re-copy the runner binaries) re-run with --re-join, ` +
        `or 'ndh runner remove ${opts.name}' first`,
    );
    return 1;
  }

  // --re-join: tear the old instance down first so `configure` starts from a clean slate. The
  // vendored `configure` refuses while a local `.runner` exists, and it never refreshes the binaries
  // on its own — so we unregister (best-effort; tolerate an unreachable hub), delete the stale
  // instance, and rebuild it below. The hub certificate is preserved across the teardown.
  if (alreadyJoined) {
    log(`re-joining '${opts.name}' — unregistering, refreshing binaries, re-registering with ${hubUrl}`);
    const savedCa = !opts.ca && (await exists(caPath(dir))) ? await readFile(caPath(dir)) : null;
    await tearDown(opts.name, dir, { token: opts.token }, deps);
    if (savedCa) {
      await mkdir(dir, { recursive: true });
      await writeFile(caPath(dir), savedCa);
    }
  }

  // (Re-)copy the current bundle into bin/. On a fresh join the dir is absent; on a re-join tearDown
  // just deleted it — either way this is what makes `join` actually refresh the runner binaries.
  log(`preparing runner instance at ${dir} ...`);
  await (deps.copyVendor ?? defaultCopyVendor)(dir);

  if (opts.ca) {
    await copyFile(opts.ca, caPath(dir));
    log(`stored hub certificate at ${caPath(dir)}`);
  }
  const url = new URL("runner/server", hubUrl.endsWith("/") ? hubUrl : `${hubUrl}/`).toString();
  const env = await listenerEnv(dir);
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
    { cwd: dir, env },
  );
  if (code !== 0) {
    // Never leave a half-configured instance that would "pretend to be joined" (listed by
    // `runner list`, tried by `runner start`). Remove the dir so the failure is unambiguous.
    await rm(dir, { recursive: true, force: true });
    log(`configure failed (exit ${code}) — cleaned up ${dir}; '${opts.name}' is not joined`);
    return code;
  }
  // The listener's .runner config does not persist labels, so record them alongside the instance:
  // `ndh runner list` (no --server) can then show what this runner offers without reaching the hub.
  await writeFile(labelsPath(dir), `${opts.labels}\n`, { mode: 0o600 }).catch(() => {});
  log(`runner '${opts.name}' joined ${hubUrl}`);
  log(`start it: ndh runner start ${opts.name}`);
  return 0;
}

/** File recording the labels a runner was joined with (the listener's .runner does not keep them). */
function labelsPath(dir: string): string {
  return join(dir, "labels");
}

/** The labels a runner instance was joined with, or "" when not recorded (e.g. joined pre-#68). */
async function readLabels(dir: string): Promise<string> {
  try {
    return (await readFile(labelsPath(dir), "utf8")).trim();
  } catch {
    return "";
  }
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
  return runner(listenerExe(dir), ["run"], { cwd: dir, env: await listenerEnv(dir) });
}

async function listNames(): Promise<string[]> {
  try {
    const entries = await readdir(join(ndhHome(), "runners"));
    // Only real runner instances (skip .DS_Store and other stray entries).
    const checked = await Promise.all(
      entries.map(async (name) => ((await exists(listenerExe(runnerDir(name)))) ? name : null)),
    );
    return checked.filter((n): n is string => n !== null);
  } catch {
    return [];
  }
}

interface ListOptions {
  server?: string;
}

/** Extra seams for `list` so the fleet source and running-state probe are testable. */
export interface ListDeps {
  fleet?: (server: string) => Promise<Fleet>;
  findListener?: (dir: string) => Promise<number[]>;
}

/**
 * `ndh runner list` — the instances joined on THIS machine, each with its labels and whether its
 * listener is running. With `--server`, the hub's whole fleet instead (labels + live state), the
 * same view the UI shows — so a headless-hub operator finally has a CLI window on the fleet (#68).
 */
async function list(opts: ListOptions = {}, deps: ListDeps = {}): Promise<number> {
  if (opts.server) {
    try {
      const { rich, agents } = await (deps.fleet ?? getFleet)(opts.server);
      console.log(`fleet @ ${opts.server}:`);
      if (agents.length === 0) {
        console.log("  (none registered)");
        return 0;
      }
      for (const a of agents) {
        console.log(rich ? `  ${a.name}  [${a.labels.join(",")}]  ${stateLabel(a)}` : `  ${a.name}  [${a.labels.join(",")}]`);
      }
      return 0;
    } catch (err) {
      if (!connErrorCode(err)) throw err;
      log(hubUnreachableMessage(opts.server));
      log(`  ${rootErrorMessage(err)}`);
      return 1;
    }
  }

  const names = await listNames();
  console.log("local runner instances:");
  if (names.length === 0) {
    console.log("  (none joined — ndh runner join <hub-url>)");
    return 0;
  }
  const find = deps.findListener ?? defaultFindListener;
  for (const name of names) {
    const dir = runnerDir(name);
    const running = (await find(dir)).length > 0;
    const labels = await readLabels(dir);
    console.log(`  ${name}  [${labels}]  ${running ? "running" : "stopped"}`);
  }
  return 0;
}

/**
 * Registration token used to unregister. Mirrors join's token flow: an explicit --token wins;
 * otherwise, when this machine also runs the hub, reuse the hub's persisted registration token
 * (the same file `ndh runner join` reads) so a co-located remove works without repeating it.
 */
async function defaultToken(opts: RemoveOptions): Promise<string> {
  if (opts.token && opts.token !== DEFAULT_TOKEN) return opts.token;
  const tokenFile = join(ndhHome(), "hub", "runner-token");
  if (await exists(tokenFile)) return (await readFile(tokenFile, "utf8")).trim();
  return opts.token;
}

/* c8 ignore start — real process discovery/signalling is exercised by the live verify, not unit tests */
/** Find listener pids for an instance by matching its binary path in the process command line. */
function defaultFindListener(dir: string): Promise<number[]> {
  const exe = listenerExe(dir);
  return new Promise((resolve) => {
    const ps = spawn("ps", ["-A", "-o", "pid=,command="]);
    let out = "";
    ps.stdout?.on("data", (d: Buffer) => (out += d));
    ps.on("error", () => resolve([]));
    ps.on("close", () => {
      const pids: number[] = [];
      for (const line of out.split("\n")) {
        if (!line.includes(exe)) continue;
        const pid = Number.parseInt(line.trim().split(/\s+/)[0], 10);
        if (Number.isInteger(pid) && pid !== process.pid) pids.push(pid);
      }
      resolve(pids);
    });
  });
}

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}
/* c8 ignore stop */

/** Run the vendored listener's `remove` in the instance dir, bounded so an unreachable hub can't hang. */
async function defaultRemoveExec(dir: string, token: string): Promise<number> {
  const env = await listenerEnv(dir);
  return new Promise((resolve) => {
    const child = spawn(listenerExe(dir), ["remove", "--token", token], { cwd: dir, env, stdio: "inherit" });
    /* c8 ignore start — the timeout/SIGKILL path needs a hung hub; covered by the live verify */
    const timer = setTimeout(() => child.kill("SIGKILL"), REMOVE_TIMEOUT_MS);
    /* c8 ignore stop */
    child.on("error", () => {
      clearTimeout(timer);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

/** SIGTERM the listener, wait out a grace window, then SIGKILL survivors. Returns true if one was running. */
async function stopListener(name: string, dir: string, deps: RunnerDeps): Promise<boolean> {
  const find = deps.findListener ?? defaultFindListener;
  const kill = deps.kill ?? defaultKill;
  const delay = deps.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let pids = await find(dir);
  if (pids.length === 0) return false;
  for (const pid of pids) kill(pid, "SIGTERM");
  for (let waited = 0; waited < STOP_GRACE_MS; waited += STOP_POLL_MS) {
    await delay(STOP_POLL_MS);
    pids = await find(dir);
    if (pids.length === 0) {
      log(`stopped listener for '${name}'`);
      return true;
    }
  }
  for (const pid of pids) kill(pid, "SIGKILL");
  log(`stopped listener for '${name}' (force-killed after ${STOP_GRACE_MS / 1000}s grace)`);
  return true;
}

/**
 * Stop the listener, best-effort unregister from the hub, and delete the instance dir. Shared by
 * `remove` and `join --re-join`: an unreachable hub is tolerated (warn) so re-joining after a hub
 * reset — where the old registration is unreachable by design — still clears the local state.
 */
async function tearDown(name: string, dir: string, opts: RemoveOptions, deps: RunnerDeps): Promise<void> {
  await stopListener(name, dir, deps);

  if (opts.force) {
    log(`--force: skipping hub unregister for '${name}'`);
  } else {
    const token = await (deps.token ?? defaultToken)(opts);
    const code = await (deps.removeExec ?? defaultRemoveExec)(dir, token);
    if (code === 0) log(`unregistered '${name}' from the hub`);
    else log(`warning: hub unreachable — it may still list agent '${name}'; remove it there manually`);
  }

  await rm(dir, { recursive: true, force: true });
}

async function remove_(name: string, opts: RemoveOptions, deps: RunnerDeps = {}): Promise<number> {
  // Unknown name (and the idempotent second-remove) share one path: refuse with the known names.
  const names = await listNames();
  if (!names.includes(name)) {
    fail(`no such runner '${name}' — known: ${names.join(", ") || "(none joined)"}`);
  }
  await tearDown(name, runnerDir(name), opts, deps);
  log(`removed runner '${name}'`);
  return 0;
}

/** Exposed for tests. */
export const __test = { join_, start, remove_, defaultToken, listenerExe, defaultName, defaultLabels, list, readLabels };
