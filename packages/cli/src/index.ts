#!/usr/bin/env node
import { ensureVendor } from "./vendor.js";
import { hubCmd } from "./hub.js";
import { runnerCmd } from "./runner.js";
import { dispatchCmd, runCmd } from "./runcmd.js";
import { statusCmd } from "./status.js";

const HELP = `notdownhub — run unmodified GitHub Actions CI on your own infrastructure

usage:
  ndh install                      download the pinned runner stack (~66MB, one time)
  ndh run [args]                   run this repo's workflows locally, one-shot
  ndh hub up [--port 4949]         start a hub: web UI + API + runner coordination + action mirror
  ndh runner join <hub-url>        register this machine as a runner (works across NAT)
  ndh runner start [name]          start a joined runner
  ndh dispatch --server <hub-url>  run this repo's workflows on the hub's runner fleet
  ndh status [--server <hub-url>]  show runners + recent runs

examples:
  ndh run -W .github/workflows/ci.yml --event push
  ndh hub up
  ndh runner join http://hub.tailnet:4949 --token <token> --labels self-hosted,macOS,ARM64
  ndh dispatch --server http://hub.tailnet:4949 --event push

docs: https://github.com/OpenSourceWTF/notdownhub.com`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "install":
      await ensureVendor(rest.includes("--force"));
      return 0;
    case "run":
      return runCmd(rest);
    case "hub":
      return hubCmd(rest);
    case "runner":
      return runnerCmd(rest);
    case "dispatch":
      return dispatchCmd(rest);
    case "status":
      return statusCmd(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return cmd ? 0 : 2;
    case "--version":
    case "-v": {
      const { readFile } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
      console.log(pkg.version);
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\x1b[31m[ndh]\x1b[0m ${err?.message ?? err}`);
    process.exit(1);
  },
);
