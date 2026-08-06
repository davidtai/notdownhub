import { parseArgs } from "node:util";
import { cp, mkdir, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { ensureVendor } from "./vendor.js";
import { exists, fail, log, ndhHome, run, vendorDir } from "./lib.js";

function runnerDir(name: string): string {
  return join(ndhHome(), "runners", name);
}

// The bundle acts as the runner's bin/ dir; the listener writes .runner/.credentials to
// bin's parent, so each instance gets its own <name>/ root with the bundle nested inside.
function listenerExe(dir: string): string {
  return join(dir, "bin", process.platform === "win32" ? "Runner.Listener.exe" : "Runner.Listener");
}

export async function runnerCmd(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "join") return join_(argv.slice(1));
  if (sub === "start") return start(argv.slice(1));
  if (sub === "list") return list();
  console.error("usage: ndh runner join <hub-url> [--name n] [--labels a,b] [--token t]\n       ndh runner start [name]\n       ndh runner list");
  return 2;
}

async function join_(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string", default: `${hostname()}-ndh` },
      labels: { type: "string", default: `self-hosted,${process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux"},${process.arch === "arm64" ? "ARM64" : "X64"}` },
      token: { type: "string", default: "notdownhub" },
    },
  });
  const hubUrl = positionals[0];
  if (!hubUrl) fail("hub url required, e.g. ndh runner join http://hub.local:4949");
  await ensureVendor();

  // Each runner needs its own directory: the listener stores .runner/.credentials beside its binary.
  const dir = runnerDir(values.name);
  if (!(await exists(listenerExe(dir)))) {
    log(`preparing runner instance at ${dir} ...`);
    await mkdir(dir, { recursive: true });
    await cp(vendorDir(), join(dir, "bin"), { recursive: true });
  }
  const url = new URL("runner/server", hubUrl.endsWith("/") ? hubUrl : `${hubUrl}/`).toString();
  const code = await run(listenerExe(dir), [
    "configure", "--unattended",
    "--url", url,
    "--token", values.token,
    "--name", values.name,
    "--labels", values.labels,
    "--work", "_work",
    "--replace",
  ], { cwd: dir });
  if (code !== 0) return code;
  log(`runner '${values.name}' joined ${hubUrl}`);
  log(`start it: ndh runner start ${values.name}`);
  return 0;
}

async function start(argv: string[]): Promise<number> {
  let name = argv[0];
  if (!name) {
    const runners = await listNames();
    if (runners.length !== 1) fail(`specify which runner: ${runners.join(", ") || "(none joined yet)"}`);
    name = runners[0];
  }
  const dir = runnerDir(name);
  if (!(await exists(listenerExe(dir)))) fail(`runner '${name}' not found — join a hub first`);
  log(`runner '${name}' listening for jobs (ctrl-c to stop)`);
  return run(listenerExe(dir), ["run"], { cwd: dir });
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
