import type { Command } from "commander";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { ensureVendor } from "./vendor.js";
import { exists, fail, log, ndhHome, randomToken, vendorExe } from "./lib.js";
import { fileLogWrite, initFileLog } from "./filelog.js";
import { startFront, uiDistDir, type FrontOptions } from "./front.js";
import { startJobLogTee } from "./joblogs.js";
import { certFingerprint, ensureSelfSignedCert } from "./tls.js";

interface HubUpOptions {
  port?: string;
  hubPort: string;
  /** commander negated flags: false when --no-* passed, true otherwise */
  auth: boolean;
  mirrorRewrite: boolean;
  ui: boolean;
  githubToken?: string;
  host?: string;
  basicAuth?: string;
  tls?: boolean;
  tlsCert?: string;
  tlsKey?: string;
}

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** First non-internal IPv4 address, used so mirror URLs are reachable from the fleet. */
function detectLanIp(): string | undefined {
  return Object.values(networkInterfaces())
    .flatMap((i) => i ?? [])
    .find((i) => i.family === "IPv4" && !i.internal)?.address;
}

export function registerHub(program: Command): void {
  const hub = program
    .command("hub")
    .description("start a hub: web UI + API + runner coordination + action mirror")
    .action(() => {
      // `ndh hub` with no subcommand — matches the original usage error + exit code.
      console.error("usage: ndh hub up [--port 4949] [--no-auth] [--no-mirror-rewrite] [--no-ui]");
      process.exitCode = 2;
    });

  hub
    .command("up")
    .description("bring the hub up and stay in the foreground")
    .option("--port <port>", "public port for UI + API + mirror (default: 4949, or 443 with --tls)")
    .option("--hub-port <port>", "internal Runner.Server port", "4950")
    .option("--host <name-or-ip>", "host runners reach the mirror at (default: LAN IP, else 127.0.0.1)")
    .option("--no-auth", "disable the runner registration token (open registration)")
    .option("--no-mirror-rewrite", "do not route action downloads through the caching mirror")
    .option("--no-ui", "do not serve the bundled web UI")
    .option("--github-token <token>", "GitHub token for the action mirror / private repos")
    .option("--tls", "serve HTTPS with a self-signed certificate (default port becomes 443)")
    .option("--tls-cert <pem>", "use an existing TLS certificate instead of the self-signed one")
    .option("--tls-key <pem>", "private key for --tls-cert")
    .option(
      "--basic-auth <user:pass>",
      "allow non-local UI access with HTTP Basic auth (default: UI is loopback-only); env NDH_BASIC_AUTH",
    )
    .action(async (opts: HubUpOptions) => {
      process.exitCode = await hubUp(opts);
    });

  hub
    .command("down")
    .description("stop a hub started by `ndh hub up` (front + Runner.Server) and free its ports")
    .action(async () => {
      process.exitCode = await hubDown();
    });
}

/** Minimal shape of the spawned child we depend on (kept tiny so tests can fake it). */
interface ChildLike {
  pid?: number;
  on(event: "exit", cb: (code: number | null) => void): unknown;
  kill(sig: NodeJS.Signals): unknown;
  stdout?: { on(event: "data", cb: (d: Buffer) => void): unknown } | null;
  stderr?: { on(event: "data", cb: (d: Buffer) => void): unknown } | null;
}

/** Minimal shape of the front server we depend on for listen/error wiring (real: http.Server). */
interface ServerLike {
  on(event: "listening" | "error", cb: (err?: Error) => void): unknown;
}

/** On-disk record `hub up` writes so `hub down` can stop the right processes. */
export interface HubPidFile {
  frontPid: number;
  childPid: number;
  port: number;
  hubPort: number;
}

/** Path to the hub pid file for the current NDH_HOME. */
export function hubPidPath(): string {
  return join(ndhHome(), "hub", "hub.pid");
}

/** The internal Runner.Server port + registration token of the hub running on THIS machine. */
export interface LocalHubTarget {
  hubPort: number;
  runnerToken?: string;
}

/**
 * Details of a hub running on this machine, from the pid file `ndh hub up` wrote (plus its
 * persisted registration token), or null when no local hub is running. Lets a co-located CLI
 * read the rich runner/run data the UI reads — via the same management-JWT + hub-DB path the
 * front uses — without going through (or weakening) the loopback-gated local API.
 */
export async function localHubTarget(): Promise<LocalHubTarget | null> {
  const rec = readPidFile(hubPidPath());
  if (!rec) return null;
  const tokenFile = join(ndhHome(), "hub", "runner-token");
  const runnerToken = (await exists(tokenFile)) ? (await readFile(tokenFile, "utf8")).trim() : undefined;
  return { hubPort: rec.hubPort, runnerToken: runnerToken || undefined };
}

/**
 * Resolve whether `port` is bindable right now. Binds an ephemeral listener on 0.0.0.0 (matching how
 * the front / Runner.Server bind all interfaces) and closes it immediately: resolves false if the
 * bind errors (e.g. EADDRINUSE), true otherwise. Never throws.
 */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

/** True if a process with `pid` currently exists (EPERM means it exists but isn't ours to signal). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read + validate the hub pid file; returns null if missing or malformed. */
function readPidFile(path: string): HubPidFile | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as Partial<HubPidFile>;
    if (typeof o.frontPid === "number" && typeof o.childPid === "number" && typeof o.port === "number" && typeof o.hubPort === "number") {
      return o as HubPidFile;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Injectable seams: the real CLI uses node's spawn + the real front + process signals/exit and
 * blocks forever; tests swap these to observe the assembled env/argv without the 200MB bundle.
 */
export interface HubDeps {
  ensure?: () => Promise<unknown>;
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildLike;
  startFront?: (opts: FrontOptions) => unknown;
  startTee?: (hubPort: number) => { stop: () => void };
  onSignal?: (sig: NodeJS.Signals, fn: () => void) => void;
  exit?: (code: number) => void;
  block?: () => Promise<number>;
  /** Pre-flight: resolve false if a port is already taken. Defaults to a real bind probe. */
  portFree?: (port: number) => Promise<boolean>;
  /** Persist / drop the pid file so `ndh hub down` can find these processes. */
  writePid?: (path: string, data: HubPidFile) => void;
  removePid?: (path: string) => void;
}

export interface HubPlan {
  port: number;
  scheme: "http" | "https";
  /** Public origin with the default port elided (https on 443, http on 80). */
  origin: string;
  hubPort: number;
  host: string;
  hubHome: string;
  token: string;
  env: NodeJS.ProcessEnv;
  uiDir: string | null;
  /** Resolved, validated "user:pass" for non-loopback UI access, or undefined (loopback-only). */
  basicAuth: string | undefined;
}

/** Resolve + validate --basic-auth / NDH_BASIC_AUTH. Malformed (no colon) is ignored with a warning. */
export function resolveBasicAuth(raw: string | undefined): string | undefined {
  const value = raw ?? process.env.NDH_BASIC_AUTH;
  if (value && !value.includes(":")) {
    log("--basic-auth must be user:pass — ignoring");
    return undefined;
  }
  return value?.includes(":") ? value : undefined;
}

/**
 * Pure(ish) hub setup: resolves host/ports, persists (or reuses) the registration token, assembles
 * the Runner.Server env (incl. fleet-reachable mirror URLs), and resolves the UI dir. No process is
 * spawned here — that's the untestable boundary hubUp handles — so this is exercised directly in tests.
 */
export async function prepareHub(opts: HubUpOptions): Promise<HubPlan> {
  const scheme: "http" | "https" = opts.tls ? "https" : "http";
  const port = opts.port !== undefined ? Number(opts.port) : opts.tls ? 443 : 4949;
  if (!isValidPort(port)) fail(`invalid --port '${opts.port}' — expected an integer 1-65535`);
  // Mirror URLs are handed to runners verbatim — they must be reachable from the fleet,
  // not just this machine. Default to our LAN address; --host overrides (DNS, tailnet, etc).
  const host = opts.host ?? detectLanIp() ?? "127.0.0.1";
  const defaultPort = scheme === "https" ? 443 : 80;
  const origin = `${scheme}://${host}${port === defaultPort ? "" : `:${port}`}`;
  const hubPort = Number(opts.hubPort);
  if (!isValidPort(hubPort)) fail(`invalid --hub-port '${opts.hubPort}' — expected an integer 1-65535`);
  const hubHome = join(ndhHome(), "hub");
  await mkdir(hubHome, { recursive: true });

  // Registration token: persisted so `ndh runner join` on other machines can reuse it.
  let token = "";
  if (opts.auth) {
    const tokenFile = join(hubHome, "runner-token");
    if (await exists(tokenFile)) {
      token = (await readFile(tokenFile, "utf8")).trim();
    } else {
      token = randomToken();
      await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  // Persist runners/runs across hub restarts (default is an in-memory DB that orphans the fleet).
  env["ConnectionStrings__sqlite"] = `Data Source=${join(hubHome, "hub.db")};`;
  // Point the engine's git server url at this hub so actions/upload-artifact stops printing a dead
  // github.com link. It is what jobs see as GITHUB_SERVER_URL / github.server_url, and the action
  // mints its "Artifact download URL" as `{server_url}/{owner}/{repo}/actions/runs/{run}/artifacts/{id}`.
  // Left at the appsettings default (https://github.com) that link points at real github.com/Unknown…;
  // pointed here, the front turns that exact path into the real hub-served artifact archive (front.ts).
  //
  // The host MUST end in `.localhost` (not our LAN IP): @actions/artifact treats any GITHUB_SERVER_URL
  // that is not github.com / *.ghe.com / *.localhost as GHES and REFUSES v4 uploads entirely — so a LAN
  // IP here would break the very upload we are fixing (verified). A `.localhost` host both passes that
  // guard and resolves to loopback, where this front (bound on all interfaces) serves the download. We
  // keep the front's real port; only the human link is local — the UI/CLI retrieve over the real host.
  // Actual upload/download traffic uses ACTIONS_RESULTS_URL, not this, so the fleet is unaffected.
  const artifactPortSuffix = port === defaultPort ? "" : `:${port}`;
  env["Runner.Server__GitServerUrl"] = `${scheme}://ndh.localhost${artifactPortSuffix}`;
  if (token) env["Runner.Server__RUNNER_TOKEN"] = token;
  if (opts.githubToken) env["Runner.Server__GITHUB_TOKEN"] = opts.githubToken;
  if (opts.mirrorRewrite) {
    // Route `uses:` downloads through our caching mirror → offline-capable after first use.
    // Host must be fleet-reachable (LAN/DNS/tailnet), not 127.0.0.1, or remote runners can't fetch.
    env["Runner.Server__ActionDownloadUrls__0__TarballUrl"] = `${origin}/mirror/{0}/tarball/{1}`;
    env["Runner.Server__ActionDownloadUrls__0__ZipballUrl"] = `${origin}/mirror/{0}/zipball/{1}`;
  }

  const candidate = opts.ui ? uiDistDir() : null;
  const uiDir = candidate && (await exists(join(candidate, "index.html"))) ? candidate : null;
  const basicAuth = resolveBasicAuth(opts.basicAuth);

  return { port, scheme, origin, hubPort, host, hubHome, token, env, uiDir, basicAuth };
}

/**
 * Resolve TLS material for the front: undefined (plain HTTP), a caller-supplied cert
 * (--tls-cert/--tls-key, both required), or a self-signed cert minted for `host`.
 */
export async function resolveTls(
  opts: Pick<HubUpOptions, "tls" | "tlsCert" | "tlsKey">,
  hubHome: string,
  host: string,
  origin: string,
): Promise<FrontOptions["tls"]> {
  if (!opts.tls) return undefined;
  if (opts.tlsCert || opts.tlsKey) {
    if (!opts.tlsCert || !opts.tlsKey) fail("--tls-cert and --tls-key must be set together");
    log(`using TLS certificate ${opts.tlsCert}`);
    return { key: await readFile(opts.tlsKey), cert: await readFile(opts.tlsCert) };
  }
  const material = await ensureSelfSignedCert(hubHome, host);
  const fp = certFingerprint(material.certPath);
  log(`self-signed certificate: ${material.certPath}${fp ? `  (SHA-256 ${fp})` : ""}`);
  log(`runners must trust it: copy cert.pem to the runner machine, then ndh runner join ${origin} --ca <path>`);
  return { key: material.key, cert: material.cert };
}

async function hubUp(opts: HubUpOptions, deps: HubDeps = {}): Promise<number> {
  await (deps.ensure ?? ensureVendor)();
  const plan = await prepareHub(opts);
  const { port, scheme, origin, hubPort, host, hubHome, token, env, uiDir, basicAuth } = plan;

  // Pre-flight: refuse before spawning anything if either port is already taken, so a second
  // `hub up` prints one human line and exits 1 instead of orphaning a fresh Runner.Server child.
  const isFree = deps.portFree ?? portFree;
  for (const p of [port, hubPort]) {
    if (!(await isFree(p))) {
      log(`a hub is already running on :${p} — run 'ndh hub down' first (or pass --port)`);
      return 1;
    }
  }

  // Start the hub log before the cert/TLS block so the certificate path + fingerprint are logged.
  const logPath = initFileLog(join(hubHome, "logs"), "hub");

  const tls = await resolveTls(opts, hubHome, host, origin);

  const spawnFn = deps.spawn ?? spawn;
  const startFrontFn = deps.startFront ?? startFront;
  const onSignal = deps.onSignal ?? ((sig, fn) => process.on(sig, fn));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const writePid = deps.writePid ?? ((path, data) => writeFileSync(path, `${JSON.stringify(data)}\n`, { mode: 0o600 }));
  const removePid = deps.removePid ?? ((path) => rmSync(path, { force: true }));
  const pidPath = join(hubHome, "hub.pid");

  const child = spawnFn(vendorExe("Runner.Server"), ["--urls", `http://*:${hubPort}`], {
    env,
    cwd: hubHome,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => {
    process.stdout.write(d);
    fileLogWrite(d);
  });
  child.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(d);
    fileLogWrite(d);
  });
  child.on("exit", (code) => {
    dropPid(pidPath, removePid);
    exit(code ?? 1);
  });

  // Persist job console output so completed runs stay readable after a restart.
  const tee = (deps.startTee ?? startJobLogTee)(hubPort);
  const stopTee = () => {
    /* c8 ignore next 3 — tee.stop() failure is a best-effort guard on the shutdown path */
    try {
      tee.stop();
    } catch {
      /* best effort */
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    onSignal(sig, () => {
      // Flush + close the job-log writer before the process exits, so the last batch is durable.
      stopTee();
      dropPid(pidPath, removePid);
      child.kill(sig);
    });

  const front = startFrontFn({ port, hubPort, uiDir, runnerToken: token || undefined, host, basicAuth, tls, githubToken: opts.githubToken });

  // Crash safety: record the pid file once the front is actually listening, and — if it fails to
  // bind for any reason (a port stolen between the pre-flight check and now, EACCES, …) — kill the
  // just-spawned Runner.Server child so nothing is left orphaned, then exit 1 with one line.
  const pidRecord: HubPidFile = { frontPid: process.pid, childPid: child.pid ?? -1, port, hubPort };
  const server = front as ServerLike | null | undefined;
  if (server && typeof server.on === "function") {
    server.on("listening", () => writePid(pidPath, pidRecord));
    server.on("error", (err) => {
      log(`could not start the hub front on :${port} — ${err?.message ?? err} (stopping Runner.Server)`);
      stopTee();
      child.kill("SIGKILL");
      dropPid(pidPath, removePid);
      exit(1);
    });
  } else {
    // No server object handed back (e.g. a test fake) — still record the pid file synchronously.
    writePid(pidPath, pidRecord);
  }

  log(`hub up on ${scheme}://localhost${port === (scheme === "https" ? 443 : 80) ? "" : `:${port}`}  (ui: ${uiDir ? (basicAuth ? "yes, basic-auth" : "yes, local-only") : "no"}, auth: ${token ? "on" : "OFF"}, mirror: ${opts.mirrorRewrite ? `on @ ${origin}/mirror` : "off"})`);
  log(`logging to ${logPath} (daily rotation)`);
  if (token) log(`runner registration token: ${token}`);
  log(`join a runner:   ndh runner join ${origin}${token ? ` --token ${token}` : ""}${opts.tls && !opts.tlsCert ? " --ca <cert.pem>" : ""}`);
  log(`dispatch a repo: ndh dispatch --server ${origin}`);
  log(`stop the hub:    ndh hub down`);
  return await (deps.block ?? (() => new Promise<number>(() => {})))();
}

/** Best-effort pid-file removal on the shutdown path (never throws). */
function dropPid(path: string, removePid: (path: string) => void): void {
  /* c8 ignore next 3 — guard on the shutdown path; removePid failure must not mask the exit code */
  try {
    removePid(path);
  } catch {
    /* best effort */
  }
}

/** Injectable seams for `hub down` so signalling/probing is unit-testable without real processes. */
export interface HubDownDeps {
  readPid?: (path: string) => HubPidFile | null;
  removePid?: (path: string) => void;
  alive?: (pid: number) => boolean;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  portFree?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

/** How long to wait after SIGTERM before escalating to SIGKILL. */
const HUB_DOWN_GRACE_MS = 3000;

/**
 * Stop a hub started by `ndh hub up`, using the pid file it wrote. Idempotent: with no pid file it
 * prints "no hub running" and exits 0. If the pid file is stale (the recorded pids are gone) it
 * refuses to guess — it never port-scans and kills blindly — and instead names any port still held.
 * When the pids are live it sends SIGTERM, escalates to SIGKILL after a short grace, then verifies
 * the ports are free.
 */
async function hubDown(deps: HubDownDeps = {}): Promise<number> {
  const readPid = deps.readPid ?? readPidFile;
  const removePid = deps.removePid ?? ((path) => rmSync(path, { force: true }));
  const alive = deps.alive ?? pidAlive;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const isFree = deps.portFree ?? portFree;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pidPath = hubPidPath();

  const rec = readPid(pidPath);
  if (!rec) {
    log("no hub running");
    return 0;
  }

  const targets: { label: string; pid: number }[] = [
    { label: "hub front", pid: rec.frontPid },
    { label: "Runner.Server", pid: rec.childPid },
  ].filter((t) => t.pid > 0);
  const live = targets.filter((t) => alive(t.pid));

  if (live.length === 0) {
    // Stale pid file: the recorded processes are gone. Never kill by port-scan — just report.
    const busy: number[] = [];
    for (const p of [rec.port, rec.hubPort]) if (!(await isFree(p))) busy.push(p);
    if (busy.length) {
      log(
        `stale pid file: recorded pids (${rec.frontPid}, ${rec.childPid}) are not running, but ${busy.map((p) => `:${p}`).join(" and ")} ${busy.length > 1 ? "are" : "is"} still in use by an unknown process — stop it manually`,
      );
      return 1;
    }
    dropPid(pidPath, removePid);
    log("no hub running (cleared a stale pid file)");
    return 0;
  }

  for (const t of live) {
    kill(t.pid, "SIGTERM");
    log(`sent SIGTERM to ${t.label} (pid ${t.pid})`);
  }
  await sleep(HUB_DOWN_GRACE_MS);
  for (const t of live) {
    if (alive(t.pid)) {
      kill(t.pid, "SIGKILL");
      log(`${t.label} (pid ${t.pid}) did not exit — sent SIGKILL`);
    }
  }

  dropPid(pidPath, removePid);

  for (const p of [rec.port, rec.hubPort]) {
    log((await isFree(p)) ? `:${p} is free` : `warning: :${p} is still in use`);
  }
  log("hub stopped");
  return 0;
}

/** Exposed for tests. */
export const __test = { prepareHub, hubUp, hubDown, detectLanIp, isValidPort, portFree, pidAlive, hubPidPath };
