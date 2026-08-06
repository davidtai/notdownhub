import type { Command } from "commander";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { ensureVendor } from "./vendor.js";
import { exists, log, ndhHome, randomToken, vendorExe } from "./lib.js";
import { startFront, uiDistDir } from "./front.js";

interface HubUpOptions {
  port: string;
  hubPort: string;
  /** commander negated flags: false when --no-* passed, true otherwise */
  auth: boolean;
  mirrorRewrite: boolean;
  ui: boolean;
  githubToken?: string;
  host?: string;
  basicAuth?: string;
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
    .option("--port <port>", "public port for UI + API + mirror", "4949")
    .option("--hub-port <port>", "internal Runner.Server port", "4950")
    .option("--host <name-or-ip>", "host runners reach the mirror at (default: LAN IP, else 127.0.0.1)")
    .option("--no-auth", "disable the runner registration token (open registration)")
    .option("--no-mirror-rewrite", "do not route action downloads through the caching mirror")
    .option("--no-ui", "do not serve the bundled web UI")
    .option("--github-token <token>", "GitHub token for the action mirror / private repos")
    .option(
      "--basic-auth <user:pass>",
      "allow non-local UI access with HTTP Basic auth (default: UI is loopback-only); env NDH_BASIC_AUTH",
    )
    .action(async (opts: HubUpOptions) => {
      process.exitCode = await hubUp(opts);
    });
}

async function hubUp(opts: HubUpOptions): Promise<number> {
  await ensureVendor();
  const port = Number(opts.port);
  // Mirror URLs are handed to runners verbatim — they must be reachable from the fleet,
  // not just this machine. Default to our LAN address; --host overrides (DNS, tailnet, etc).
  const host = opts.host ?? detectLanIp() ?? "127.0.0.1";
  const hubPort = Number(opts.hubPort);
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
  if (token) env["Runner.Server__RUNNER_TOKEN"] = token;
  if (opts.githubToken) env["Runner.Server__GITHUB_TOKEN"] = opts.githubToken;
  if (opts.mirrorRewrite) {
    // Route `uses:` downloads through our caching mirror → offline-capable after first use.
    // Host must be fleet-reachable (LAN/DNS/tailnet), not 127.0.0.1, or remote runners can't fetch.
    env["Runner.Server__ActionDownloadUrls__0__TarballUrl"] = `http://${host}:${port}/mirror/{0}/tarball/{1}`;
    env["Runner.Server__ActionDownloadUrls__0__ZipballUrl"] = `http://${host}:${port}/mirror/{0}/zipball/{1}`;
  }

  const child = spawn(vendorExe("Runner.Server"), ["--urls", `http://*:${hubPort}`], {
    env,
    cwd: hubHome,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));

  const uiDir = opts.ui ? uiDistDir() : null;
  const ui = uiDir && (await exists(join(uiDir, "index.html"))) ? uiDir : null;
  const basicAuth = opts.basicAuth ?? process.env.NDH_BASIC_AUTH;
  if (basicAuth && !basicAuth.includes(":")) {
    log("--basic-auth must be user:pass — ignoring");
  }
  const basic = basicAuth?.includes(":") ? basicAuth : undefined;
  startFront({ port, hubPort, uiDir: ui, runnerToken: token || undefined, host, basicAuth: basic });

  log(`hub up on http://localhost:${port}  (ui: ${ui ? (basic ? "yes, basic-auth" : "yes, local-only") : "no"}, auth: ${token ? "on" : "OFF"}, mirror: ${opts.mirrorRewrite ? `on @ http://${host}:${port}/mirror` : "off"})`);
  if (token) log(`runner registration token: ${token}`);
  log(`join a runner:   ndh runner join http://${host}:${port}${token ? ` --token ${token}` : ""}`);
  log(`dispatch a repo: ndh dispatch --server http://${host}:${port}`);
  return await new Promise(() => {});
}
