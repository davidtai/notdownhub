import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { exists, log } from "./lib.js";
import { currentRepoSlug } from "./scope.js";

/**
 * `ndh hook install <repo> [--type <t>] [--server <hub>]` (issues #23, #120).
 *
 * Writes a git hook that triggers CI. Four types:
 *
 *   post-receive (default, server) — a push to a bare repo dispatches CI on the hub;
 *                                    the push itself never fails on CI (#23).
 *   pre-receive          (server)  — CI-gated push: dispatch the pushed tree and REJECT
 *                                    the push when a workflow fails (#120).
 *   pre-push             (client)  — run CI on what is about to be pushed, from the
 *                                    developer's checkout; a failure blocks the push.
 *   post-commit          (client)  — advisory CI after each commit; never blocks (git
 *                                    ignores a post-commit hook's exit status).
 *
 * Server types validate a bare repo and write into `<repo>/hooks/`. Client types validate
 * a working checkout root and write into its `git rev-parse --git-path hooks` directory.
 * Client hooks run `ndh run` locally by default; `--server` switches them to dispatch.
 */

/**
 * Marker line embedded in every generated hook. `install` uses it to tell an ndh-managed hook
 * (safe to overwrite) from a hand-written one (refuse without --force). Keep it stable — changing
 * it makes older managed hooks look foreign.
 */
export const HOOK_MARKER = "# managed by: ndh hook install (regenerate to update)";

/**
 * The line Runner.Client prints when EVERY workflow was skipped by an `on: push: branches:`
 * filter. The pre-receive/pre-push gates grep for it: a filtered-out branch is not a CI
 * failure, so it must never reject or block a push (see preReceiveShouldReject).
 */
export const ALL_SKIPPED_MARKER = "All Workflows skipped";

export const HOOK_TYPES = ["post-receive", "pre-receive", "pre-push", "post-commit"] as const;
export type HookType = (typeof HOOK_TYPES)[number];

/**
 * The absolute way to run THIS ndh install, resolved at `hook install` time and embedded in
 * every generated hook (#133). Hooks used to invoke a bare `ndh`, which required ndh on the
 * hook environment's PATH — git hooks read no shell profile and no aliases, so the documented
 * from-source alias install lost every CI dispatch silently. Embedding `<node> <entry>` makes
 * the hook independent of PATH entirely.
 */
export interface NdhInvocation {
  /** Absolute node binary running the CLI (process.execPath). */
  node: string;
  /** Absolute, realpath'd ndh CLI entry script (dist/index.js). */
  entry: string;
}

/**
 * Resolve the invocation to embed. Default: `process.execPath` + realpath of `process.argv[1]`.
 * All supported install shapes land on the real entry script:
 *   - npm/pnpm global bin shim: a symlink (or exec wrapper) onto dist/index.js — argv[1] is the
 *     shim path (realpath follows it) or already the real entry (pnpm's sh shim execs node on it);
 *   - from-source symlink (`ln -s .../dist/index.js ~/bin/ndh`): realpath follows it;
 *   - direct `node packages/cli/dist/index.js`: realpath makes it absolute.
 * `override` is the documented `--ndh <path>` escape hatch for exotic layouts; it must point at
 * a JS entry runnable by `node` and is realpath'd the same way.
 */
export function resolveNdhInvocation(override?: string): NdhInvocation {
  const raw = override ?? process.argv[1];
  if (!raw) throw new Error("cannot resolve the running ndh entry script — pass --ndh <path>");
  let entry: string;
  try {
    entry = realpathSync(resolve(raw));
  } catch {
    throw new Error(
      override
        ? `--ndh path does not exist: ${raw}`
        : `cannot resolve the running ndh entry script (${raw}) — pass --ndh <path>`,
    );
  }
  return { node: process.execPath, entry };
}

/** Server-side types install into a bare repo; the other two into a working checkout. */
export function isServerHookType(type: HookType): boolean {
  return type === "post-receive" || type === "pre-receive";
}

/**
 * The pre-receive gate decision, as one pure testable rule. Reject the push only when the
 * dispatch failed FOR REAL: exit 0 always accepts; a nonzero exit accepts anyway when the
 * output proves every workflow was skipped by branch filters (ALL_SKIPPED_MARKER) — a
 * branch no workflow tracks must never be rejected. Anything else nonzero (failed job,
 * unreachable hub, infra error) rejects: a gate that cannot verify CI fails closed.
 * The generated pre-receive/pre-push shell mirrors this exact rule.
 */
export function preReceiveShouldReject(exitCode: number, output: string): boolean {
  if (exitCode === 0) return false;
  return !output.includes(ALL_SKIPPED_MARKER);
}

/** Quote an arbitrary value for safe single-quoted embedding in POSIX sh. */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Keep a slug segment to git-ish safe chars; mirrors projectSlug's sanitizer (runcmd.ts). */
function slugSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Default `owner/repo` slug for a repo, derived from its path (#99): the repo's directory
 * name minus a trailing `.git`, owned by the name of its parent directory. So
 * `/srv/git/team/app.git` → `team/app`, and a flat layout `/srv/git/app.git` → `git/app`.
 * `--repository` always overrides. Two parts always: the engine records the value verbatim and
 * splits on "/" for the owner, so a one-part value would render as `Unknown/Unknown`.
 */
export function deriveRepoSlug(repoPath: string): string {
  const abs = resolve(repoPath);
  const name = slugSegment(basename(abs).replace(/\.git$/i, ""));
  const owner = slugSegment(basename(dirname(abs)));
  return `${owner || "git"}/${name || "repo"}`;
}

export interface HookConfig {
  /**
   * Hub base url passed to `ndh dispatch --server`. Required for the server types; optional
   * for client types, where its absence means "run CI locally via `ndh run`".
   */
  server?: string;
  /** Project slug (`owner/repo`) passed via `--repository`; labels every hook run (#99). */
  repository: string;
  /** Optional workflow file; when set the hook adds `-W <workflow>`. Default: dispatch all. */
  workflow?: string;
  /** Absolute node binary the hook invokes; see NdhInvocation (#133). */
  ndhNode: string;
  /** Absolute ndh CLI entry script the hook invokes; see NdhInvocation (#133). */
  ndhEntry: string;
}

/** The `NDH_*`/`HUB=`/`REPO=`/`WORKFLOW=` variable block, every value single-quote-escaped. */
function hookVars(config: HookConfig): string {
  const lines: string[] = [
    `NDH_NODE=${shSingleQuote(config.ndhNode)}`,
    `NDH_ENTRY=${shSingleQuote(config.ndhEntry)}`,
  ];
  if (config.server) lines.push(`HUB=${shSingleQuote(config.server)}`);
  lines.push(`REPO=${shSingleQuote(config.repository)}`);
  if (config.workflow) lines.push(`WORKFLOW=${shSingleQuote(config.workflow)}`);
  return lines.join("\n");
}

/**
 * The ndh invocation for a hook: dispatch when a server is configured, a local one-shot
 * `ndh run` otherwise. Always `"$NDH_NODE" "$NDH_ENTRY" …` — the absolute install resolved
 * at generation time — never a bare `ndh`, which PATH-less hook environments cannot find
 * (#133). `refArgs` is the shell fragment naming the ref (already quoted), e.g.
 * `--ref "$ref"`, or `"$@"` for post-commit's precomputed args.
 */
function ndhCiInvocation(config: HookConfig, refArgs: string): string {
  const wf = config.workflow ? ` -W "$WORKFLOW"` : "";
  const sub = config.server ? `dispatch --server "$HUB" --repository "$REPO"` : `run --repository "$REPO"`;
  return `"$NDH_NODE" "$NDH_ENTRY" ${sub} --event push ${refArgs}${wf}`;
}

/**
 * Exit code a gate hook uses when the embedded ndh install is gone: distinct from the CI-failure
 * exit (1) and the infra sentinel (90) so an operator can tell the cases apart at a glance.
 */
export const NDH_MISSING_EXIT = 97;

/** Per-type consequence line for the missing-install guard (embedded verbatim in the hook). */
const GUARD_CONSEQUENCE: Record<HookType, string> = {
  "post-receive": "CI was NOT dispatched for this push. The push itself already landed.",
  "pre-receive": "The gate cannot run CI, so this push is REJECTED (fail closed).",
  "pre-push": "The gate cannot run CI, so this push is BLOCKED (fail closed).",
  "post-commit": "Advisory CI did not run for this commit.",
};

/**
 * The up-front guard every generated hook starts with (#133): if the embedded install moved or
 * was deleted, print an unmissable multi-line `[ndh] ERROR` (git relays it as `remote:` lines)
 * naming the fix — re-run `ndh hook install`. Gate types (pre-receive/pre-push) exit
 * NDH_MISSING_EXIT so the push fails closed; advisory types (post-receive/post-commit) cannot
 * retroactively fail their event, so they exit 0 after shouting.
 */
function ndhGuardFragment(type: HookType): string {
  const gate = type === "pre-receive" || type === "pre-push";
  return `if ! [ -x "$NDH_NODE" ] || ! [ -f "$NDH_ENTRY" ]; then
  echo "[ndh] ============================================================" >&2
  echo "[ndh] ERROR: the ndh install this ${type} hook points to is gone:" >&2
  echo "[ndh]   node:  $NDH_NODE" >&2
  echo "[ndh]   entry: $NDH_ENTRY" >&2
  echo "[ndh] ${GUARD_CONSEQUENCE[type]}" >&2
  echo "[ndh] Fix: re-run 'ndh hook install' to regenerate this hook." >&2
  echo "[ndh] ============================================================" >&2
  exit ${gate ? NDH_MISSING_EXIT : 0}
fi`;
}

/**
 * The shared gate body for pre-receive/pre-push: run CI on the tree in `$work`, stream the
 * output to the pusher AND capture it, then apply preReceiveShouldReject. POSIX sh has no
 * pipefail, so the exit code travels through a status file ($st) written inside the pipeline;
 * a missing/garbled status counts as failure (fail closed, exit 90). `</dev/null` keeps ndh
 * from eating the ref list still pending on the hook's stdin.
 */
function gatedRunFragment(invocation: string, failMsg: string, allowMsg: string): string {
  const skip = shSingleQuote(ALL_SKIPPED_MARKER);
  return `  out=$(mktemp)
  st=$(mktemp)
  ( set +e
    cd "$work" || exit 90
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    ${invocation} </dev/null 2>&1
    echo $? >"$st"
  ) | tee "$out"
  code=$(cat "$st" 2>/dev/null || echo 90)
  case "$code" in ''|*[!0-9]*) code=90 ;; esac
  rm -rf "$work"
  if [ "$code" -ne 0 ] && ! grep -q ${skip} "$out"; then
    echo "[ndh] CI failed for $branch (exit $code) — ${failMsg}" >&2
    grep "Completed with Status: Failed" "$out" | sed 's/^/[ndh]   /' >&2 || true
    rm -f "$out" "$st"
    exit 1
  fi
  if grep -q ${skip} "$out"; then
    echo "[ndh] workflows skipped by filters for $branch — ${allowMsg}"
  else
    echo "[ndh] CI passed for $branch — ${allowMsg}"
  fi
  rm -f "$out" "$st"`;
}

/**
 * Build the post-receive hook script (POSIX sh). Pure and deterministic so tests assert the
 * embedded server/repository/workflow and the ref loop directly. The hub url, repository slug,
 * and workflow (when set) are single-quote-escaped, so any value is embedded safely.
 *
 * `--repository` is baked in because the hook dispatches from a temp work-tree with no origin
 * remote (and git runs post-receive with a relative GIT_DIR), so ndh cannot infer the project
 * there — without it every push was labeled `local/<mktemp-dir>` and repo-scoped secrets never
 * resolved (#99).
 *
 * Branch deletions (all-zero new sha) have no tree to dispatch and are skipped (#120) — the
 * original template tried to check out sha 0{40} and errored into the push output.
 */
export function generateHook(config: HookConfig): string {
  if (!config.server) throw new Error("post-receive hooks dispatch to a hub — a server url is required");
  return `#!/bin/sh
${HOOK_MARKER}
# On push, dispatch CI on the hub for each updated branch. The workflow's
# 'on: push: branches:' filter is applied per branch via --ref. Branch
# deletions dispatch nothing.
set -eu

${hookVars(config)}

${ndhGuardFragment("post-receive")}

while read -r _old new ref; do
  case "$ref" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  case "$new" in
    *[!0]*) ;;
    *) continue ;;
  esac
  branch=\${ref#refs/heads/}
  work=$(mktemp -d)
  git --work-tree="$work" checkout -f "$new"
  ( cd "$work" && ${ndhCiInvocation(config, '--ref "$ref"')} )
  rm -rf "$work"
  echo "[ndh] dispatched $branch ($ref)"
done
`;
}

/**
 * Build the pre-receive hook script: the CI-gated push. Per pushed branch, dispatch the pushed
 * tree and wait; a real failure exits 1, which makes git reject the ENTIRE push (git's
 * pre-receive is all-or-nothing) — the gate stops at the first failing branch. The skip-vs-fail
 * rule is preReceiveShouldReject, mirrored in shell (exit code + ALL_SKIPPED_MARKER grep).
 *
 * Unlike post-receive, the tree is exported with `git archive`, NOT `git checkout`: pre-receive
 * runs inside git's quarantine environment, where checkout's HEAD update is forbidden
 * ("ref updates forbidden inside quarantine environment" — found live). Archive only reads
 * objects, which quarantine allows. Branch deletions (all-zero new sha) have no tree and pass.
 */
export function generatePreReceiveHook(config: HookConfig): string {
  if (!config.server) throw new Error("pre-receive hooks dispatch to a hub — a server url is required");
  const gate = gatedRunFragment(ndhCiInvocation(config, '--ref "$ref"'), "push rejected", "branch gate passed");
  return `#!/bin/sh
${HOOK_MARKER}
# CI-GATED PUSH (pre-receive): each pushed branch is exported to a temp
# work-tree and dispatched to the hub, and the push WAITS for the result.
# A failing workflow REJECTS the whole push (all refs — git's pre-receive is
# all-or-nothing); an unreachable hub rejects too (the gate fails closed).
# Workflows skipped by an 'on: push: branches:' filter never reject, and
# branch deletions are not gated. Tradeoff: every push to this repo blocks
# for the full CI duration — the post-receive type is the fire-and-forget
# alternative.
set -eu

${hookVars(config)}

${ndhGuardFragment("pre-receive")}

while read -r _old new ref; do
  case "$ref" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  case "$new" in
    *[!0]*) ;;
    *) continue ;;
  esac
  branch=\${ref#refs/heads/}
  work=$(mktemp -d)
  git archive "$new" | tar -xf - -C "$work"
${gate}
done
`;
}

/**
 * Build the pre-push hook script (client). For each branch being pushed it exports the pushed
 * COMMIT (not the possibly-dirty working tree) with `git archive` — a plain `git checkout`
 * here would move the checkout's own HEAD/index — and runs CI on it: `ndh run` locally, or
 * `ndh dispatch` when a server is configured. A real failure exits 1, which makes git abort
 * the push before anything leaves the machine; the skip rule matches preReceiveShouldReject.
 * Branch deletions (all-zero local sha) have no tree to test and pass through.
 */
export function generatePrePushHook(config: HookConfig): string {
  const gate = gatedRunFragment(ndhCiInvocation(config, '--ref "$rref"'), "push blocked", "branch gate passed");
  return `#!/bin/sh
${HOOK_MARKER}
# CI gate before push (pre-push): each branch being pushed is exported to a
# temp work-tree and CI runs on it${config.server ? " via the hub" : " locally with `ndh run`"}. A failing
# workflow blocks the push before it leaves this machine. Workflows skipped
# by branch filters never block. stdin lines: <lref> <lsha> <rref> <rsha>.
set -eu

${hookVars(config)}

${ndhGuardFragment("pre-push")}

while read -r _lref lsha rref _rsha; do
  case "$rref" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  case "$lsha" in
    *[!0]*) ;;
    *) continue ;;
  esac
  branch=\${rref#refs/heads/}
  work=$(mktemp -d)
  git archive "$lsha" | tar -xf - -C "$work"
${gate}
done
`;
}

/**
 * Build the post-commit hook script (client). Advisory by design: git IGNORES a post-commit
 * hook's exit status — the commit object already exists before the hook runs — so no exit
 * code could ever block or undo it. Hence no --strict variant: it would change nothing. The
 * hook exports the committed tree (HEAD, not the working tree), runs CI on it, prints a
 * passed/failed/skipped verdict, and always exits 0.
 */
export function generatePostCommitHook(config: HookConfig): string {
  const skip = shSingleQuote(ALL_SKIPPED_MARKER);
  const invocation = ndhCiInvocation(config, '"$@"');
  return `#!/bin/sh
${HOOK_MARKER}
# ADVISORY CI after each commit: the committed tree (HEAD) is exported to a
# temp work-tree and CI runs on it${config.server ? " via the hub" : " locally with `ndh run`"}. git ignores this
# hook's exit status — a post-commit hook can never block or undo a commit —
# so this hook only reports the outcome and always exits 0.
set -u

${hookVars(config)}

${ndhGuardFragment("post-commit")}

sha=$(git rev-parse --short HEAD)
if ref=$(git symbolic-ref -q HEAD); then
  set -- --ref "$ref"
else
  set --
fi
work=$(mktemp -d)
out=$(mktemp)
st=$(mktemp)
if ! git archive HEAD | tar -xf - -C "$work"; then
  echo "[ndh] advisory CI skipped: cannot export HEAD" >&2
  rm -rf "$work"
  rm -f "$out" "$st"
  exit 0
fi
( set +e
  cd "$work" || exit 90
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
  ${invocation} </dev/null 2>&1
  echo $? >"$st"
) | tee "$out"
code=$(cat "$st" 2>/dev/null || echo 90)
case "$code" in ''|*[!0-9]*) code=90 ;; esac
rm -rf "$work"
if grep -q ${skip} "$out"; then
  echo "[ndh] advisory CI: workflows skipped by filters for commit $sha"
elif [ "$code" -eq 0 ]; then
  echo "[ndh] advisory CI passed for commit $sha"
else
  echo "[ndh] advisory CI FAILED for commit $sha (exit $code) — the commit itself stands" >&2
  grep "Completed with Status: Failed" "$out" | sed 's/^/[ndh]   /' >&2
fi
rm -f "$out" "$st"
exit 0
`;
}

/** Generate the hook script for any type; the per-type builders stay individually testable. */
export function generateHookOfType(type: HookType, config: HookConfig): string {
  switch (type) {
    case "post-receive":
      return generateHook(config);
    case "pre-receive":
      return generatePreReceiveHook(config);
    case "pre-push":
      return generatePrePushHook(config);
    case "post-commit":
      return generatePostCommitHook(config);
  }
}

/**
 * Injectable seams so the install flow is testable without shelling out. Defaults shell out to
 * git; tests point them at real `git init` dirs or stub them.
 */
export interface HookDeps {
  isBareRepo?: (repoPath: string) => boolean;
  /** True when repoPath is the ROOT of a non-bare checkout (client hooks install there). */
  isWorkingRepoRoot?: (repoPath: string) => boolean;
  /** Absolute hooks dir of a working checkout (`git rev-parse --git-path hooks`), or null. */
  hooksPath?: (repoPath: string) => string | null;
  /** Origin-remote slug of a working checkout, for client attribution. Default: currentRepoSlug. */
  originSlug?: (repoPath: string) => string | null;
}

/** True when `git rev-parse --is-bare-repository` reports true for `repoPath`. */
function gitIsBareRepo(repoPath: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-bare-repository"], { cwd: repoPath, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

/**
 * True when `repoPath` is the top level of a working (non-bare) checkout. `--show-toplevel`
 * fails in a bare repo and outside any repo; comparing real paths rejects a subdirectory of
 * a larger repo, whose hooks dir would belong to the parent.
 */
function gitIsWorkingRepoRoot(repoPath: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repoPath, encoding: "utf8" });
  if (r.status !== 0) return false;
  const top = r.stdout.trim();
  if (!top) return false;
  try {
    return realpathSync(top) === realpathSync(repoPath);
  } catch {
    return false;
  }
}

/**
 * The checkout's hooks directory via `git rev-parse --git-path hooks`, resolved absolute.
 * Honors core.hooksPath and linked work-trees, unlike a hardcoded `.git/hooks`.
 */
function gitHooksPath(repoPath: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: repoPath, encoding: "utf8" });
  if (r.status !== 0) return null;
  const p = r.stdout.trim();
  return p ? resolve(repoPath, p) : null;
}

export interface InstallOptions {
  /** Hook type to install; default post-receive (the original behavior). */
  type?: string;
  /** Hub url. Required for server types; optional for client types (default: local `ndh run`). */
  server?: string;
  /** Explicit `owner/repo` project slug; default: derived (origin remote, then repo path). */
  repository?: string;
  workflow?: string;
  force?: boolean;
  /** `--ndh <path>`: override the embedded CLI entry script (default: the running install). */
  ndh?: string;
}

/** One post-install hint line per type, printed after the config summary. */
const TYPE_HINTS: Record<HookType, string> = {
  "post-receive": "push a branch to this repo to trigger CI (the hook runs this ndh install by absolute path)",
  "pre-receive": "pushes now wait for CI; a failing workflow rejects the push",
  "pre-push": "`git push` from this checkout now runs CI first; a failing workflow blocks the push",
  "post-commit": "every commit now gets an advisory CI run; the commit itself is never blocked",
};

/**
 * Validate the target repo for the requested hook type and write the hook (0755). Server types
 * (post-receive, pre-receive) require a bare repo and `--server`; client types (pre-push,
 * post-commit) require a working checkout root. Throws (surfaced by index.ts as
 * `[ndh] <message>`, exit 1) on a bad path, a wrong-shaped repo, an unknown type, or a
 * foreign existing hook without --force.
 */
export async function installHook(repoPath: string, opts: InstallOptions, deps: HookDeps = {}): Promise<void> {
  const type = (opts.type ?? "post-receive") as HookType;
  if (!HOOK_TYPES.includes(type)) {
    throw new Error(`unknown hook type: ${opts.type} — valid types: ${HOOK_TYPES.join(", ")}`);
  }
  const serverSide = isServerHookType(type);
  if (serverSide && !opts.server) {
    throw new Error(`--type ${type} dispatches to a hub — pass --server <url>`);
  }
  const invocation = resolveNdhInvocation(opts.ndh);

  if (!(await exists(repoPath))) throw new Error(`no such path: ${repoPath}`);
  if (!(await stat(repoPath)).isDirectory()) throw new Error(`not a directory: ${repoPath}`);

  let hooksDir: string;
  let repository: string;
  let derivation = "";
  if (serverSide) {
    const isBare = deps.isBareRepo ?? gitIsBareRepo;
    if (!isBare(repoPath)) {
      throw new Error(`not a bare git repository: ${repoPath} — pass the path to a bare *.git repo (git init --bare)`);
    }
    hooksDir = join(repoPath, "hooks");
    repository = opts.repository ?? deriveRepoSlug(repoPath);
    if (!opts.repository) derivation = " (derived from the repo path; override with --repository)";
  } else {
    const isWorkingRoot = deps.isWorkingRepoRoot ?? gitIsWorkingRepoRoot;
    if (!isWorkingRoot(repoPath)) {
      throw new Error(
        `not a working checkout: ${repoPath} — --type ${type} is a client-side hook; pass the root of a non-bare clone`,
      );
    }
    hooksDir = (deps.hooksPath ?? gitHooksPath)(repoPath) ?? join(repoPath, ".git", "hooks");
    if (opts.repository) {
      repository = opts.repository;
    } else {
      const origin = (deps.originSlug ?? currentRepoSlug)(repoPath);
      repository = origin ?? deriveRepoSlug(repoPath);
      derivation = origin
        ? " (derived from the origin remote; override with --repository)"
        : " (derived from the repo path; override with --repository)";
    }
  }

  const hookPath = join(hooksDir, type);
  if (await exists(hookPath)) {
    const current = await readFile(hookPath, "utf8");
    if (!current.includes(HOOK_MARKER) && !opts.force) {
      throw new Error(`refusing to overwrite an existing ${type} hook at ${hookPath} — pass --force to replace it`);
    }
  }

  await mkdir(hooksDir, { recursive: true });
  const script = generateHookOfType(type, {
    server: opts.server,
    repository,
    workflow: opts.workflow,
    ndhNode: invocation.node,
    ndhEntry: invocation.entry,
  });
  await writeFile(hookPath, script, { mode: 0o755 });
  await chmod(hookPath, 0o755);

  log(`installed ${type} hook: ${hookPath}`);
  log(`  server:     ${opts.server ?? "(none — CI runs locally via `ndh run`; pass --server to dispatch)"}`);
  log(`  repository: ${repository}${derivation}`);
  log(`  workflow:   ${opts.workflow ?? "(all workflows)"}`);
  log(`  ndh:        ${invocation.node} ${invocation.entry}${opts.ndh ? " (--ndh override)" : ""}`);
  log(TYPE_HINTS[type]);
}

export function registerHook(program: Command): void {
  const hook = program
    .command("hook")
    .description("install git hooks (server- or client-side) that trigger CI")
    .action(() => {
      hook.help();
    });

  hook
    .command("install")
    .description("write a git hook so a push or commit triggers CI (see --type)")
    .argument("<repo>", "target repo: a bare repo for server hooks, a checkout root for client hooks")
    .option("--type <type>", `hook type: ${HOOK_TYPES.join(" | ")}`, "post-receive")
    .option(
      "--server <url>",
      "hub base url, e.g. http://hub.local:4949 (required for server hooks; switches client hooks from local `ndh run` to dispatch)",
    )
    .option(
      "--repository <owner/repo>",
      "project slug for hook runs (default: derived from the origin remote or the repo path)",
    )
    .option("-W, --workflow <path>", "dispatch a specific workflow file (default: all workflows)")
    .option("--force", "overwrite an existing hook of the same type that ndh did not write")
    .option(
      "--ndh <path>",
      "ndh CLI entry script to embed in the hook (default: the running install, resolved to an absolute path)",
    )
    .action(
      async (
        repo: string,
        opts: { type: string; server?: string; repository?: string; workflow?: string; force?: boolean; ndh?: string },
      ) => {
        await installHook(repo, {
          type: opts.type,
          server: opts.server,
          repository: opts.repository,
          workflow: opts.workflow,
          force: opts.force,
          ndh: opts.ndh,
        });
        process.exitCode = 0;
      },
    );
}

/** Exposed for tests. */
export const __test = { gitIsBareRepo, gitIsWorkingRepoRoot, gitHooksPath };
