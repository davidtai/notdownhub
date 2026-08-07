#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { ensureVendor } from "./vendor.js";
import { registerHub } from "./hub.js";
import { registerRunner } from "./runner.js";
import { runCmd, dispatchCmd } from "./runcmd.js";
import { registerStatus } from "./status.js";
import { registerSecrets } from "./secrets.js";

const EXAMPLES = `
examples:
  ndh run -W .github/workflows/ci.yml --event push
  ndh hub up
  ndh runner join http://hub.tailnet:4949 --token <token> --labels self-hosted,macOS,ARM64
  ndh dispatch --server http://hub.tailnet:4949 --event push
  ndh secrets set NPM_TOKEN

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
    .description("run this repo's workflows locally, one-shot")
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
  registerSecrets(program);
  return program;
}

async function main(): Promise<number> {
  const raw = process.argv.slice(2);

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
