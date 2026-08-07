#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { ensureVendor } from "./vendor.js";
import { registerHub } from "./hub.js";
import { registerRunner } from "./runner.js";
import { runCmd, dispatchCmd } from "./runcmd.js";
import { runCancelCmd, runDeleteCmd } from "./run-actions.js";
import { rerunCmd } from "./rerun.js";
import { registerStatus } from "./status.js";
import { registerProjects } from "./projects.js";
import { registerProjectAdd } from "./project-add.js";
import { registerSecrets } from "./secrets.js";
import { registerVars } from "./vars.js";
import { registerHook } from "./hook.js";
import { registerLogs } from "./logs.js";
import { registerArtifacts } from "./artifacts-cmd.js";

const EXAMPLES = `
examples:
  ndh run -W .github/workflows/ci.yml --event push
  ndh run rerun 2 --server http://hub.tailnet:4949
  ndh run cancel 42 --server http://hub.tailnet:4949
  ndh run delete 42 --server http://hub.tailnet:4949
  ndh run delete --project acme/widget --server http://hub.tailnet:4949
  ndh hub up
  ndh runner join http://hub.tailnet:4949 --token <token> --labels self-hosted,macOS,ARM64
  ndh dispatch --server http://hub.tailnet:4949 --event push
  ndh projects --server http://hub.tailnet:4949
  ndh hook install /srv/git/app.git --server http://hub.tailnet:4949
  ndh secrets set NPM_TOKEN
  ndh vars set DEPLOY_TARGET staging

docs: https://github.com/davidtai/notdownhub`;

async function version(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  return pkg.version as string;
}

async function buildProgram(): Promise<Command> {
  const program = new Command();
  program
    .name("ndh")
    .description("notdownhub — run unmodified GitHub Actions CI on your own infrastructure")
    .version(await version(), "-v, --version", "print the ndh version")
    .enablePositionalOptions()
    .showHelpAfterError()
    .addHelpText("after", EXAMPLES);

  program
    .command("install")
    .description("download the pinned runner stack (~66MB, one time)")
    .option("--force", "re-download even if already present")
    .action(async (opts: { force?: boolean }) => {
      await ensureVendor(Boolean(opts.force));
      process.exitCode = 0;
    });

  // run/dispatch are intercepted in main() so their args reach Runner.Client verbatim; these
  // registrations exist so they appear in `ndh --help` / `ndh help run` and act as a fallback.
  program
    .command("run")
    .description("run this repo's workflows locally, one-shot (also: run rerun/cancel/delete <id> --server <hub>)")
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .argument("[args...]", "passed verbatim to Runner.Client (e.g. -W .github/workflows/ci.yml --event push)")
    /* c8 ignore start -- fallback only: main() intercepts `run` before commander parses, so this
       action body is never executed; the registration exists purely for --help / `ndh help run`. */
    .action(async (args: string[]) => {
      process.exitCode = await runCmd(args);
    });
  /* c8 ignore stop */

  program
    .command("dispatch")
    .description("run this repo's workflows on the hub's runner fleet")
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .argument("[args...]", "e.g. --server http://hub:4949 --event push (passed verbatim to Runner.Client)")
    /* c8 ignore start -- fallback only: main() intercepts `dispatch` before commander parses. */
    .action(async (args: string[]) => {
      process.exitCode = await dispatchCmd(args);
    });
  /* c8 ignore stop */

  registerHub(program);
  registerRunner(program);
  registerStatus(program);
  registerProjects(program);
  registerProjectAdd(program);
  registerSecrets(program);
  registerVars(program);
  registerHook(program);
  registerLogs(program);
  registerArtifacts(program);
  return program;
}

async function main(): Promise<number> {
  const raw = process.argv.slice(2);

  // `run rerun` / `run cancel` / `run delete` are ndh run-management verbs — intercept them
  // before the verbatim passthrough, or their args would be handed to Runner.Client.
  if (raw[0] === "run" && raw[1] === "rerun") return rerunCmd(raw.slice(2));
  if (raw[0] === "run" && raw[1] === "cancel") return runCancelCmd(raw.slice(2));
  if (raw[0] === "run" && raw[1] === "delete") return runDeleteCmd(raw.slice(2));

  // Verbatim passthrough: everything after `run`/`dispatch` goes to Runner.Client untouched,
  // including a leading `--` and flags like --help. commander would otherwise consume them.
  if (raw[0] === "run") return runCmd(raw.slice(1));
  if (raw[0] === "dispatch") return dispatchCmd(raw.slice(1));

  const program = await buildProgram();
  if (raw.length === 0) {
    program.outputHelp();
    return 2;
  }

  program.exitOverride();
  try {
    await program.parseAsync(process.argv);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    const e = err as { code?: string; exitCode?: number; message?: string };
    if (typeof e.code === "string" && e.code.startsWith("commander.")) {
      // Commander-originated: it already printed help / the usage error to the console.
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help") {
        return 0;
      }
      // Preserve original usage exit codes: missing required argument was a hard fail (1);
      // everything else (unknown command/option, bad usage) is 2.
      return e.code === "commander.missingArgument" ? 1 : 2;
    }
    // Error thrown *inside* a command action (e.g. `ndh status` with the hub down). Under
    // exitOverride() commander does NOT print these, so surface it like the old fail() handler:
    // `[ndh] <message>` on stderr, exit 1.
    console.error(`\x1b[31m[ndh]\x1b[0m ${e?.message ?? err}`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\x1b[31m[ndh]\x1b[0m ${err?.message ?? err}`);
    process.exit(1);
  },
);
