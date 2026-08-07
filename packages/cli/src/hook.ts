import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { exists, log } from "./lib.js";

/**
 * `ndh hook install <bare-repo.git> --server <hub>` (issue #23).
 *
 * Writes a `post-receive` hook onto a bare git server so a `git push` triggers CI on the hub.
 * The generated hook is the automated form of the manual recipe in docs/operations.md
 * ("Triggering CI"): for each pushed branch it checks the pushed tree into a temp work-tree and
 * runs `ndh dispatch` from there, so a workflow's `on: push: branches:` filter applies per branch.
 */

/**
 * Marker line embedded in every generated hook. `install` uses it to tell an ndh-managed hook
 * (safe to overwrite) from a hand-written one (refuse without --force). Keep it stable — changing
 * it makes older managed hooks look foreign.
 */
export const HOOK_MARKER = "# managed by: ndh hook install (regenerate to update)";

/** Quote an arbitrary value for safe single-quoted embedding in POSIX sh. */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface HookConfig {
  /** Hub base url passed to `ndh dispatch --server`. */
  server: string;
  /** Optional workflow file; when set the hook adds `-W <workflow>`. Default: dispatch all. */
  workflow?: string;
}

/**
 * Build the post-receive hook script (POSIX sh). Pure and deterministic so tests assert the
 * embedded server/workflow and the ref loop directly. The hub url (and workflow, when set) are
 * single-quote-escaped, so any value is embedded safely.
 */
export function generateHook(config: HookConfig): string {
  const server = shSingleQuote(config.server);
  const workflowArg = config.workflow ? ` -W "$WORKFLOW"` : "";
  const workflowVar = config.workflow ? `WORKFLOW=${shSingleQuote(config.workflow)}\n` : "";
  return `#!/bin/sh
${HOOK_MARKER}
# On push, dispatch CI on the hub for each updated branch. The workflow's
# 'on: push: branches:' filter is applied per branch via --ref.
set -eu

HUB=${server}
${workflowVar}
while read -r _old new ref; do
  case "$ref" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  branch=\${ref#refs/heads/}
  work=$(mktemp -d)
  git --work-tree="$work" checkout -f "$new"
  ( cd "$work" && ndh dispatch --server "$HUB" --event push --ref "$ref"${workflowArg} )
  rm -rf "$work"
  echo "[ndh] dispatched $branch ($ref)"
done
`;
}

/**
 * Injectable seams so the install flow is testable without shelling out. `isBareRepo` defaults to
 * `git rev-parse --is-bare-repository`; tests point it at a real `git init --bare` dir or stub it.
 */
export interface HookDeps {
  isBareRepo?: (repoPath: string) => boolean;
}

/** True when `git rev-parse --is-bare-repository` reports true for `repoPath`. */
function gitIsBareRepo(repoPath: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-bare-repository"], { cwd: repoPath, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

export interface InstallOptions {
  server: string;
  workflow?: string;
  force?: boolean;
}

/**
 * Validate the target bare repo and write its `post-receive` hook (0755). Throws (surfaced by
 * index.ts as `[ndh] <message>`, exit 1) on a bad path, a non-bare repo, or a foreign existing
 * hook without --force.
 */
export async function installHook(repoPath: string, opts: InstallOptions, deps: HookDeps = {}): Promise<void> {
  if (!(await exists(repoPath))) throw new Error(`no such path: ${repoPath}`);
  if (!(await stat(repoPath)).isDirectory()) throw new Error(`not a directory: ${repoPath}`);

  const isBare = deps.isBareRepo ?? gitIsBareRepo;
  if (!isBare(repoPath)) {
    throw new Error(`not a bare git repository: ${repoPath} — pass the path to a bare *.git repo (git init --bare)`);
  }

  const hooksDir = join(repoPath, "hooks");
  const hookPath = join(hooksDir, "post-receive");

  if (await exists(hookPath)) {
    const current = await readFile(hookPath, "utf8");
    if (!current.includes(HOOK_MARKER) && !opts.force) {
      throw new Error(`refusing to overwrite an existing post-receive hook at ${hookPath} — pass --force to replace it`);
    }
  }

  await mkdir(hooksDir, { recursive: true });
  const script = generateHook({ server: opts.server, workflow: opts.workflow });
  await writeFile(hookPath, script, { mode: 0o755 });
  await chmod(hookPath, 0o755);

  log(`installed post-receive hook: ${hookPath}`);
  log(`  server:   ${opts.server}`);
  log(`  workflow: ${opts.workflow ?? "(all workflows)"}`);
  log("push a branch to this repo to trigger CI (needs `ndh` on the server's PATH)");
}

export function registerHook(program: Command): void {
  const hook = program
    .command("hook")
    .description("install git-server hooks that trigger CI on push")
    .action(() => {
      hook.help();
    });

  hook
    .command("install")
    .description("write a post-receive hook onto a bare repo so a push triggers CI")
    .argument("<repo>", "path to a bare git repo (e.g. /srv/git/app.git)")
    .requiredOption("--server <url>", "hub base url, e.g. http://hub.local:4949")
    .option("-W, --workflow <path>", "dispatch a specific workflow file (default: all workflows)")
    .option("--force", "overwrite an existing post-receive hook that ndh did not write")
    .action(async (repo: string, opts: { server: string; workflow?: string; force?: boolean }) => {
      await installHook(repo, { server: opts.server, workflow: opts.workflow, force: opts.force });
      process.exitCode = 0;
    });
}

/** Exposed for tests. */
export const __test = { gitIsBareRepo };
