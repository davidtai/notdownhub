import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureVendor } from "./vendor.js";
import { exists, log, ndhHome, randomToken, vendorExe } from "./lib.js";
import { startFront, uiDistDir } from "./front.js";

export async function hubCmd(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4949" },
      "hub-port": { type: "string", default: "4950" },
      "no-auth": { type: "boolean", default: false },
      "no-mirror-rewrite": { type: "boolean", default: false },
      "no-ui": { type: "boolean", default: false },
      "github-token": { type: "string" },
      host: { type: "string" },
    },
  });
  if (positionals[0] !== "up") {
    console.error("usage: ndh hub up [--port 4949] [--no-auth] [--no-mirror-rewrite] [--no-ui]");
    return 2;
  }
  await ensureVendor();
  const port = Number(values.port);
  // Mirror URLs are handed to runners verbatim — they must be reachable from the fleet,
  // not just this machine. Default to our LAN address; --host overrides (DNS, tailnet, etc).
  const { networkInterfaces } = await import("node:os");
  const lanIp = Object.values(networkInterfaces()).flatMap((i) => i ?? []).find((i) => i.family === "IPv4" && !i.internal)?.address;
  const host = values.host ?? lanIp ?? "127.0.0.1";
  const hubPort = Number(values["hub-port"]);
  const hubHome = join(ndhHome(), "hub");
  await mkdir(hubHome, { recursive: true });

  // Registration token: persisted so `ndh runner join` on other machines can reuse it.
  let token = "";
  if (!values["no-auth"]) {
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
  if (values["github-token"]) env["Runner.Server__GITHUB_TOKEN"] = values["github-token"];
  if (!values["no-mirror-rewrite"]) {
    // Route `uses:` downloads through our caching mirror → offline-capable after first use.
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

  const uiDir = values["no-ui"] ? null : uiDistDir();
  const ui = uiDir && (await exists(join(uiDir, "index.html"))) ? uiDir : null;
  startFront({ port, hubPort, uiDir: ui, runnerToken: token || undefined });

  log(`hub up on http://localhost:${port}  (ui: ${ui ? "yes" : "no"}, auth: ${token ? "on" : "OFF"}, mirror: ${values["no-mirror-rewrite"] ? "off" : "on"})`);
  if (token) log(`runner registration token: ${token}`);
  log(`join a runner:   ndh runner join http://<this-host>:${port}${token ? ` --token ${token}` : ""}`);
  log(`dispatch a repo: ndh dispatch --server http://<this-host>:${port}`);
  return await new Promise(() => {});
}
