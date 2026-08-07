import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ALL_SKIPPED_MARKER,
  HOOK_MARKER,
  HOOK_TYPES,
  NDH_MISSING_EXIT,
  __test,
  deriveRepoSlug,
  generateHook,
  generateHookOfType,
  generatePostCommitHook,
  generatePreReceiveHook,
  generatePrePushHook,
  installHook,
  isServerHookType,
  preReceiveShouldReject,
  resolveNdhInvocation,
  shSingleQuote,
} from "../hook.js";
import { cliPath, runCli } from "./helpers.js";

/** Create a real bare repo in a fresh temp dir and return its path. */
function bareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ndh-hook-bare-"));
  const r = spawnSync("git", ["init", "--bare", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, `git init --bare failed: ${r.stderr}`);
  return dir;
}

/** Create a real non-bare repo (has a work-tree) and return its path. */
function workingRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ndh-hook-work-"));
  const r = spawnSync("git", ["init", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
  return dir;
}

/**
 * Fixed invocation fixture for generator assertions (#133). Every generated hook embeds the
 * absolute node + entry the installing ndh resolved; bare `ndh` is gone from all invocations.
 */
const INV = { ndhNode: "/opt/node/bin/node", ndhEntry: "/opt/ndh/dist/index.js" };
/** The shell prefix every generated invocation must use instead of bare `ndh`. */
const CALL = '"$NDH_NODE" "$NDH_ENTRY"';

// ---------- shSingleQuote ----------

test("shSingleQuote: wraps plain values and escapes embedded single quotes", () => {
  assert.equal(shSingleQuote("http://hub:4949"), "'http://hub:4949'");
  // a value containing a quote closes/escapes/reopens: it's -> 'it'\''s'
  assert.equal(shSingleQuote("it's"), "'it'\\''s'");
});

// ---------- resolveNdhInvocation (#133) ----------

test("resolveNdhInvocation: default embeds this node binary and the running entry, realpath'd", () => {
  const inv = resolveNdhInvocation();
  assert.equal(inv.node, process.execPath, "node is process.execPath (absolute)");
  assert.equal(inv.entry, realpathSync(process.argv[1]), "entry is argv[1], symlinks resolved");
});

test("resolveNdhInvocation: a bin-shim/from-source symlink resolves through to the real entry", () => {
  // npm's unix bin shim and `ln -s dist/index.js ~/bin/ndh` are both a symlink onto the entry.
  const dir = mkdtempSync(join(tmpdir(), "ndh-inv-"));
  const real = join(dir, "real-entry.js");
  writeFileSync(real, "// entry\n");
  const link = join(dir, "ndh");
  symlinkSync(real, link);
  const inv = resolveNdhInvocation(link);
  assert.equal(inv.entry, realpathSync(real), "the symlink is resolved, not embedded");
  assert.equal(inv.node, process.execPath);
});

test("resolveNdhInvocation: a missing --ndh path fails with a clear error", () => {
  assert.throws(() => resolveNdhInvocation("/no/such/ndh-entry.js"), /--ndh path does not exist/);
});

// ---------- deriveRepoSlug ----------

test("deriveRepoSlug: nested layout uses the parent dir as owner", () => {
  assert.equal(deriveRepoSlug("/srv/git/team/app.git"), "team/app");
  assert.equal(deriveRepoSlug("/srv/git/team/app.git/"), "team/app"); // trailing slash
});

test("deriveRepoSlug: flat layout falls back to the containing dir as owner", () => {
  assert.equal(deriveRepoSlug("/srv/git/app.git"), "git/app");
});

test("deriveRepoSlug: strips only a trailing .git, keeping dotted repo names intact", () => {
  assert.equal(deriveRepoSlug("/srv/git/my.app.git"), "git/my.app");
  assert.equal(deriveRepoSlug("/srv/git/team/app"), "team/app"); // bare dir without .git suffix
});

test("deriveRepoSlug: sanitizes odd characters and never yields an empty segment", () => {
  assert.equal(deriveRepoSlug("/srv/my team/the repo!.git"), "my-team/the-repo");
  assert.equal(deriveRepoSlug("/app.git"), "git/app"); // repo at filesystem root: owner fallback
});

// ---------- generateHook ----------

test("generateHook: embeds server + repository + invocation, loops refs/heads/*, no -W by default", () => {
  const script = generateHook({ server: "http://hub.local:4949", repository: "team/app", ...INV });
  assert.ok(script.startsWith("#!/bin/sh\n"), "POSIX sh shebang");
  assert.ok(script.includes(HOOK_MARKER), "carries the managed marker");
  assert.ok(script.includes("NDH_NODE='/opt/node/bin/node'"), "single-quoted absolute node (#133)");
  assert.ok(script.includes("NDH_ENTRY='/opt/ndh/dist/index.js'"), "single-quoted absolute entry (#133)");
  assert.ok(script.includes("HUB='http://hub.local:4949'"), "single-quoted server url");
  assert.ok(script.includes("REPO='team/app'"), "single-quoted repository slug (#99)");
  assert.ok(script.includes("refs/heads/*)"), "only branch refs pass the case filter (tags ignored)");
  assert.ok(script.includes("*[!0]*"), "all-zero new sha (branch deletion) dispatches nothing (#120)");
  assert.ok(script.includes('git --work-tree="$work" checkout -f "$new"'), "checks out the pushed tree");
  assert.ok(
    script.includes(`${CALL} dispatch --server "$HUB" --repository "$REPO" --event push --ref "$ref"`),
    "dispatches via the embedded absolute invocation, never bare ndh (#133)",
  );
  assert.ok(!script.includes(" ndh dispatch"), "no bare ndh invocation remains");
  assert.ok(!script.includes("WORKFLOW="), "no WORKFLOW var when none configured");
});

test("generateHook: propagates the workflow flag when configured", () => {
  const script = generateHook({ server: "http://h:4949", repository: "t/a", workflow: ".github/workflows/ci.yml", ...INV });
  assert.ok(script.includes("WORKFLOW='.github/workflows/ci.yml'"), "single-quoted workflow var");
  assert.ok(
    script.includes(`${CALL} dispatch --server "$HUB" --repository "$REPO" --event push --ref "$ref" -W "$WORKFLOW"`),
    "adds -W to the dispatch",
  );
});

test("generateHook: a server url or repository with a single quote stays single-quote-safe", () => {
  const script = generateHook({ server: "http://ho'st:4949", repository: "te'am/app", ...INV });
  assert.ok(script.includes("HUB='http://ho'\\''st:4949'"), "quote is escaped, not left dangling");
  assert.ok(script.includes("REPO='te'\\''am/app'"), "repository quote is escaped too");
});

test("generateHook: node/entry paths with spaces and quotes embed single-quote-safe (#133)", () => {
  const script = generateHook({
    server: "http://h:1",
    repository: "t/a",
    ndhNode: "/opt/no de/bin/node",
    ndhEntry: "/opt/ndh's dist/index.js",
  });
  assert.ok(script.includes("NDH_NODE='/opt/no de/bin/node'"), "space survives inside single quotes");
  assert.ok(script.includes("NDH_ENTRY='/opt/ndh'\\''s dist/index.js'"), "quote is escaped");
});

// ---------- hook type taxonomy ----------

test("hook types: exactly four, server-vs-client split is stable", () => {
  assert.deepEqual([...HOOK_TYPES], ["post-receive", "pre-receive", "pre-push", "post-commit"]);
  assert.equal(isServerHookType("post-receive"), true);
  assert.equal(isServerHookType("pre-receive"), true);
  assert.equal(isServerHookType("pre-push"), false);
  assert.equal(isServerHookType("post-commit"), false);
});

// ---------- the missing-install guard (#133) ----------

test("guard: every hook type embeds the loud missing-install check with the re-install fix line", () => {
  const config = { server: "http://hub:4949", repository: "team/app", ...INV };
  for (const type of HOOK_TYPES) {
    const script = generateHookOfType(type, config);
    assert.ok(script.includes('if ! [ -x "$NDH_NODE" ] || ! [ -f "$NDH_ENTRY" ]; then'), `${type}: guard present`);
    assert.ok(script.includes(`ERROR: the ndh install this ${type} hook points to is gone`), `${type}: names itself`);
    assert.ok(script.includes("re-run 'ndh hook install'"), `${type}: names the fix`);
  }
});

test("guard: gate types fail closed (exit 97); advisory types shout but exit 0", () => {
  const config = { server: "http://hub:4949", repository: "team/app", ...INV };
  assert.equal(NDH_MISSING_EXIT, 97, "distinct from CI failure (1) and the infra sentinel (90)");
  assert.ok(generateHookOfType("pre-receive", config).includes(`REJECTED (fail closed)`));
  assert.ok(generateHookOfType("pre-receive", config).includes(`exit ${NDH_MISSING_EXIT}`));
  assert.ok(generateHookOfType("pre-push", config).includes(`BLOCKED (fail closed)`));
  assert.ok(generateHookOfType("pre-push", config).includes(`exit ${NDH_MISSING_EXIT}`));
  const postReceive = generateHookOfType("post-receive", config);
  assert.ok(postReceive.includes("CI was NOT dispatched for this push"), "post-receive names the loss");
  assert.ok(!postReceive.includes(`exit ${NDH_MISSING_EXIT}`), "post-receive never fails the landed push");
  const postCommit = generateHookOfType("post-commit", config);
  assert.ok(postCommit.includes("Advisory CI did not run"), "post-commit names the loss");
  assert.ok(!postCommit.includes(`exit ${NDH_MISSING_EXIT}`), "post-commit never fails the commit");
});

// ---------- preReceiveShouldReject (the pure gate decision) ----------

test("preReceiveShouldReject: exit 0 never rejects, whatever the output", () => {
  assert.equal(preReceiveShouldReject(0, ""), false);
  assert.equal(preReceiveShouldReject(0, "Job Completed with Status: Failed"), false);
  assert.equal(preReceiveShouldReject(0, ALL_SKIPPED_MARKER), false);
});

test("preReceiveShouldReject: nonzero with a real failure rejects", () => {
  assert.equal(preReceiveShouldReject(1, "Job Completed with Status: Failed"), true);
  assert.equal(preReceiveShouldReject(2, ""), true, "no output at all still fails closed");
  assert.equal(preReceiveShouldReject(90, "mktemp: no space"), true, "infra failure fails closed");
});

test("preReceiveShouldReject: nonzero but all-workflows-skipped does NOT reject", () => {
  const skipLog = `Skipping Workflow, due to branches filter. github.ref='refs/heads/feature'\n${ALL_SKIPPED_MARKER}, due to filters\n`;
  assert.equal(preReceiveShouldReject(1, skipLog), false, "a filtered branch is not a CI failure");
  // The marker anywhere in the streamed log counts — it is a full-line Runner.Client message.
  assert.equal(preReceiveShouldReject(1, `noise before\n${skipLog}noise after`), false);
});

// ---------- generatePreReceiveHook ----------

test("generatePreReceiveHook: gated dispatch — archive export, tee'd output, skip-aware reject", () => {
  const script = generatePreReceiveHook({ server: "http://hub.local:4949", repository: "team/app", ...INV });
  assert.ok(script.startsWith("#!/bin/sh\n"), "POSIX sh shebang");
  assert.ok(script.includes(HOOK_MARKER), "carries the managed marker");
  assert.ok(script.includes("NDH_NODE='/opt/node/bin/node'"), "absolute invocation embedded (#133)");
  assert.ok(script.includes("HUB='http://hub.local:4949'"));
  assert.ok(script.includes("REPO='team/app'"));
  assert.ok(script.includes("refs/heads/*)"), "only branch refs pass the case filter (tags ignored)");
  assert.ok(script.includes("*[!0]*"), "all-zero new sha (branch deletion) is not gated");
  assert.ok(
    script.includes('git archive "$new" | tar -xf - -C "$work"'),
    "exports via archive — checkout is forbidden inside pre-receive quarantine",
  );
  assert.ok(!script.includes("checkout -f"), "no checkout: quarantine forbids its HEAD update");
  assert.ok(
    script.includes(`${CALL} dispatch --server "$HUB" --repository "$REPO" --event push --ref "$ref"`),
    "dispatches per pushed ref via the absolute invocation",
  );
  assert.ok(!script.includes(" ndh dispatch"), "no bare ndh invocation remains (#133)");
  assert.ok(script.includes(`grep -q '${ALL_SKIPPED_MARKER}'`), "skip detection greps the shared marker");
  assert.ok(script.includes("exit 1"), "a real failure rejects the push");
  assert.ok(script.includes("push rejected"), "reject message names the outcome");
  assert.ok(script.includes('grep "Completed with Status: Failed"'), "rejection re-prints the failed workflow/job lines");
  assert.match(script, /blocks\s*\n?# for the full CI duration/, "header documents the blocking tradeoff");
  assert.ok(!script.includes("WORKFLOW="), "no workflow flag when none configured");
});

test("generatePreReceiveHook: workflow flag and quote-safety", () => {
  const script = generatePreReceiveHook({
    server: "http://ho'st:4949",
    repository: "te'am/app",
    workflow: "ci's.yml",
    ...INV,
  });
  assert.ok(script.includes("HUB='http://ho'\\''st:4949'"), "server quote escaped");
  assert.ok(script.includes("REPO='te'\\''am/app'"), "repository quote escaped");
  assert.ok(script.includes("WORKFLOW='ci'\\''s.yml'"), "workflow quote escaped");
  assert.ok(script.includes('-W "$WORKFLOW"'), "adds -W to the dispatch");
});

test("generatePreReceiveHook: requires a server (pre-receive always dispatches)", () => {
  assert.throws(() => generatePreReceiveHook({ repository: "t/a", ...INV }), /server url is required/);
  assert.throws(() => generateHook({ repository: "t/a", ...INV }), /server url is required/);
});

// ---------- generatePrePushHook ----------

test("generatePrePushHook: local mode runs `ndh run` on the exported pushed commit", () => {
  const script = generatePrePushHook({ repository: "team/app", ...INV });
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.ok(script.includes(HOOK_MARKER));
  assert.ok(!script.includes("HUB="), "no hub var in local mode");
  assert.ok(script.includes("REPO='team/app'"));
  assert.ok(
    script.includes(`${CALL} run --repository "$REPO" --event push --ref "$rref"`),
    "local one-shot run via the absolute invocation, labeled, per remote ref",
  );
  assert.ok(!script.includes(" ndh run --repository"), "no bare ndh invocation remains (#133)");
  assert.ok(script.includes('git archive "$lsha" | tar -xf - -C "$work"'), "exports the pushed commit, not the working tree");
  assert.ok(!script.includes("checkout -f"), "never git-checkouts inside a working clone (would move HEAD)");
  assert.ok(script.includes("*[!0]*"), "all-zero sha (branch deletion) passes through untested");
  assert.ok(script.includes(`grep -q '${ALL_SKIPPED_MARKER}'`), "skip-aware, same rule as pre-receive");
  assert.ok(script.includes("push blocked"), "failure blocks the push");
});

test("generatePrePushHook: --server switches the gate to hub dispatch", () => {
  const script = generatePrePushHook({ server: "http://hub:4949", repository: "team/app", workflow: "ci.yml", ...INV });
  assert.ok(script.includes("HUB='http://hub:4949'"));
  assert.ok(
    script.includes(`${CALL} dispatch --server "$HUB" --repository "$REPO" --event push --ref "$rref" -W "$WORKFLOW"`),
    "dispatch mode with workflow",
  );
  assert.ok(!script.includes('"$NDH_ENTRY" run '), "no local run in dispatch mode");
});

test("generatePrePushHook: quote-safety for repository in local mode", () => {
  const script = generatePrePushHook({ repository: "te'am/app", ...INV });
  assert.ok(script.includes("REPO='te'\\''am/app'"));
});

// ---------- generatePostCommitHook ----------

test("generatePostCommitHook: advisory — exports HEAD, reports, always exits 0", () => {
  const script = generatePostCommitHook({ repository: "team/app", ...INV });
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.ok(script.includes(HOOK_MARKER));
  assert.ok(script.trimEnd().endsWith("exit 0"), "the hook's last word is exit 0");
  assert.ok(!script.includes("set -e"), "no set -e: nothing may abort before the advisory verdict");
  assert.ok(script.includes("git archive HEAD | tar -xf - -C"), "runs the committed tree, not the dirty checkout");
  assert.ok(script.includes(`${CALL} run --repository "$REPO" --event push "$@"`), "local advisory run");
  assert.ok(script.includes("git symbolic-ref -q HEAD"), "branch ref when on a branch, none when detached");
  assert.ok(script.includes("advisory CI FAILED"), "failure is reported, not enforced");
  assert.ok(script.match(/exit 1/) === null, "no failing exit path exists");
});

test("generatePostCommitHook: --server dispatches; workflow and quotes embed safely", () => {
  const script = generatePostCommitHook({ server: "http://h'ub:4949", repository: "team/app", workflow: "ci.yml", ...INV });
  assert.ok(script.includes("HUB='http://h'\\''ub:4949'"));
  assert.ok(script.includes(`${CALL} dispatch --server "$HUB" --repository "$REPO" --event push "$@" -W "$WORKFLOW"`));
  assert.ok(script.trimEnd().endsWith("exit 0"), "still advisory in dispatch mode");
});

// ---------- generateHookOfType ----------

test("generateHookOfType: maps every type; post-receive matches generateHook byte-for-byte", () => {
  const config = { server: "http://hub:4949", repository: "team/app", ...INV };
  assert.equal(generateHookOfType("post-receive", config), generateHook(config), "default type is unchanged");
  assert.ok(generateHookOfType("pre-receive", config).includes("push rejected"));
  assert.ok(generateHookOfType("pre-push", config).includes("push blocked"));
  assert.ok(generateHookOfType("post-commit", config).includes("advisory"));
  for (const type of HOOK_TYPES) {
    assert.ok(generateHookOfType(type, config).includes(HOOK_MARKER), `${type} carries the marker`);
  }
});

// ---------- gitIsBareRepo (default seam) ----------

test("gitIsBareRepo: true for a real bare repo, false for a working repo and a non-repo", () => {
  assert.equal(__test.gitIsBareRepo(bareRepo()), true);
  assert.equal(__test.gitIsBareRepo(workingRepo()), false);
  assert.equal(__test.gitIsBareRepo(mkdtempSync(join(tmpdir(), "ndh-hook-plain-"))), false);
});

// ---------- installHook ----------

/** Create a real bare repo at <tmp>/team/app.git so the derived slug is deterministic. */
function nestedBareRepo(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ndh-hook-nested-")), "team", "app.git");
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("git", ["init", "--bare", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, `git init --bare failed: ${r.stderr}`);
  return dir;
}

test("installHook: writes an executable post-receive hook into a bare repo", async () => {
  const repo = bareRepo();
  await installHook(repo, { server: "http://hub:4949", workflow: ".github/workflows/ci.yml" });
  const hookPath = join(repo, "hooks", "post-receive");
  const content = readFileSync(hookPath, "utf8");
  assert.ok(content.includes("HUB='http://hub:4949'"));
  assert.ok(content.includes("WORKFLOW='.github/workflows/ci.yml'"));
  assert.ok(content.includes(HOOK_MARKER));
  assert.ok(content.includes(`NDH_NODE=${shSingleQuote(process.execPath)}`), "installer's node embedded (#133)");
  assert.equal(statSync(hookPath).mode & 0o777, 0o755, "hook must be chmod 0755");
});

test("installHook: without --repository the hook embeds the slug derived from the repo path (#99)", async () => {
  const repo = nestedBareRepo(); // <tmp>/team/app.git
  await installHook(repo, { server: "http://hub:4949" });
  const content = readFileSync(join(repo, "hooks", "post-receive"), "utf8");
  assert.ok(content.includes("REPO='team/app'"), `derived slug embedded, got:\n${content}`);
  assert.ok(content.includes('--repository "$REPO"'), "dispatch line carries the label");
});

test("installHook: an explicit --repository always wins over the derived slug", async () => {
  const repo = nestedBareRepo(); // would derive team/app
  await installHook(repo, { server: "http://hub:4949", repository: "acme/widget" });
  const content = readFileSync(join(repo, "hooks", "post-receive"), "utf8");
  assert.ok(content.includes("REPO='acme/widget'"));
  assert.ok(!content.includes("REPO='team/app'"));
});

test("installHook: regenerating a pre-#99 managed hook (marker, no REPO) picks up the new template", async () => {
  const repo = nestedBareRepo();
  const hookPath = join(repo, "hooks", "post-receive");
  mkdirSync(join(repo, "hooks"), { recursive: true });
  // Old template: has the marker, dispatches without --repository.
  writeFileSync(
    hookPath,
    `#!/bin/sh\n${HOOK_MARKER}\nHUB='http://old:4949'\nndh dispatch --server "$HUB" --event push\n`,
    { mode: 0o755 },
  );
  await installHook(repo, { server: "http://hub:4949" }); // no --force needed: marker flow
  const content = readFileSync(hookPath, "utf8");
  assert.ok(content.includes("REPO='team/app'"), "regenerated hook gains the derived label");
  assert.ok(content.includes('--repository "$REPO"'));
});

test("installHook: reinstall regenerates an old bare-ndh managed hook with the absolute invocation (#133)", async () => {
  const repo = nestedBareRepo();
  const hookPath = join(repo, "hooks", "post-receive");
  mkdirSync(join(repo, "hooks"), { recursive: true });
  // Pre-#133 template: marker present, dispatches via a bare `ndh` that needs PATH.
  writeFileSync(
    hookPath,
    `#!/bin/sh\n${HOOK_MARKER}\nHUB='http://old:4949'\nREPO='team/app'\nndh dispatch --server "$HUB" --repository "$REPO" --event push\n`,
    { mode: 0o755 },
  );
  await installHook(repo, { server: "http://hub:4949" }); // marker flow: no --force needed
  const content = readFileSync(hookPath, "utf8");
  assert.ok(content.includes(`NDH_NODE=${shSingleQuote(process.execPath)}`), "absolute node embedded");
  assert.ok(content.includes(`${CALL} dispatch`), "invocation goes through the embedded paths");
  assert.ok(!content.includes("\nndh dispatch"), "the bare PATH-dependent invocation is gone");
});

test("installHook: creates the hooks dir when it is missing", async () => {
  const repo = bareRepo();
  // Remove the hooks dir git created, to exercise the mkdir path.
  spawnSync("rm", ["-rf", join(repo, "hooks")]);
  await installHook(repo, { server: "http://hub:4949" });
  assert.ok(readFileSync(join(repo, "hooks", "post-receive"), "utf8").includes("HUB="));
});

test("installHook: refuses to overwrite a foreign hook without --force, replaces with it", async () => {
  const repo = bareRepo();
  const hookPath = join(repo, "hooks", "post-receive");
  mkdirSync(join(repo, "hooks"), { recursive: true });
  writeFileSync(hookPath, "#!/bin/sh\necho hand-written\n", { mode: 0o755 });

  await assert.rejects(
    () => installHook(repo, { server: "http://hub:4949" }),
    /refusing to overwrite an existing post-receive hook/,
  );
  // untouched
  assert.ok(readFileSync(hookPath, "utf8").includes("hand-written"));

  // --force replaces it
  await installHook(repo, { server: "http://hub:4949", force: true });
  const replaced = readFileSync(hookPath, "utf8");
  assert.ok(!replaced.includes("hand-written"));
  assert.ok(replaced.includes(HOOK_MARKER));
});

test("installHook: overwrites an existing ndh-managed hook without --force", async () => {
  const repo = bareRepo();
  await installHook(repo, { server: "http://old:4949" });
  // Re-install (its marker is present) with a new server: allowed, no --force needed.
  await installHook(repo, { server: "http://new:4949" });
  assert.ok(readFileSync(join(repo, "hooks", "post-receive"), "utf8").includes("HUB='http://new:4949'"));
});

test("installHook: rejects a missing path, a file path, and a non-bare repo", async () => {
  await assert.rejects(
    () => installHook(join(tmpdir(), "ndh-hook-does-not-exist-xyz"), { server: "http://h:4949" }),
    /no such path/,
  );

  const file = join(mkdtempSync(join(tmpdir(), "ndh-hook-file-")), "f");
  writeFileSync(file, "x");
  await assert.rejects(() => installHook(file, { server: "http://h:4949" }), /not a directory/);

  await assert.rejects(
    () => installHook(workingRepo(), { server: "http://h:4949" }),
    /not a bare git repository/,
  );
});

test("installHook: the isBareRepo seam is honored (stubbed true writes the hook)", async () => {
  // A plain dir the default check would reject; the stub forces the bare branch.
  const dir = mkdtempSync(join(tmpdir(), "ndh-hook-stub-"));
  await installHook(dir, { server: "http://h:4949" }, { isBareRepo: () => true });
  assert.ok(readFileSync(join(dir, "hooks", "post-receive"), "utf8").includes("HUB="));
});

// ---------- generated hooks, executed (fake ndh entry, real git repos) ----------

/**
 * Behavioral fake for the embedded invocation (#133): an entry SCRIPT (run by "$NDH_NODE",
 * which the config points at /bin/sh) whose argv log, output, and exit code we control. The
 * entry's filename contains a space AND a single quote, so every exec test doubles as a
 * quote-safety test for the embedded absolute paths.
 */
function fakeNdh(behavior: { exit: number; output?: string }): {
  config: { ndhNode: string; ndhEntry: string };
  calls: () => string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "ndh-hook-exec-"));
  const callLog = join(dir, "calls.log");
  const entry = join(dir, "ndh's fake entry");
  const fake = `#!/bin/sh\necho "$@" >> ${JSON.stringify(callLog)}\n${
    // %b so the JSON-escaped \n become real newlines: the fake output is genuinely multi-line.
    behavior.output ? `printf '%b\\n' ${JSON.stringify(behavior.output)}\n` : ""
  }exit ${behavior.exit}\n`;
  writeFileSync(entry, fake, { mode: 0o755 });
  return {
    config: { ndhNode: "/bin/sh", ndhEntry: entry },
    calls: () => {
      try {
        return readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Execute a generated hook with `sh` inside a real repo, exactly like git would — stdin lines
 * and all. PATH is scrubbed to the system dirs, with no `ndh` anywhere on it: the embedded
 * absolute invocation must work with zero PATH help (#133 — the cold-start scenario where the
 * old bare-ndh hooks lost every CI dispatch silently).
 */
function runHookScript(
  script: string,
  opts: { stdin?: string; cwd: string },
): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "ndh-hook-run-"));
  const hookFile = join(dir, "hook");
  writeFileSync(hookFile, script, { mode: 0o755 });
  const r = spawnSync("sh", [hookFile], {
    cwd: opts.cwd,
    input: opts.stdin ?? "",
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A bare repo containing one commit on main; returns { repo, sha }. */
function bareRepoWithCommit(): { repo: string; sha: string } {
  const work = workingRepo();
  spawnSync("git", ["-C", work, "config", "user.email", "t@t"]);
  spawnSync("git", ["-C", work, "config", "user.name", "t"]);
  writeFileSync(join(work, "file.txt"), "hello\n");
  spawnSync("git", ["-C", work, "add", "-A"]);
  spawnSync("git", ["-C", work, "commit", "-qm", "c1"]);
  const sha = spawnSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const repo = bareRepo();
  spawnSync("git", ["-C", work, "push", "-q", repo, "HEAD:refs/heads/main"]);
  return { repo, sha };
}

/** A working repo with one commit; returns { repo, sha }. */
function workingRepoWithCommit(): { repo: string; sha: string } {
  const repo = workingRepo();
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "hello\n");
  spawnSync("git", ["-C", repo, "add", "-A"]);
  spawnSync("git", ["-C", repo, "commit", "-qm", "c1"]);
  const sha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  return { repo, sha };
}

const ZERO = "0".repeat(40);
const SKIP_OUT = `| Skipping Workflow, due to branches filter. github.ref='refs/heads/f'\n${ALL_SKIPPED_MARKER}, due to filters`;
const FAIL_OUT = "[app-ci / build] Job Completed with Status: Failed\n[ci.yml] Workflow 1 Completed with Status: Failed";

test("exec pre-receive: CI pass accepts, CI fail rejects (exit 1) and names the failed workflow", () => {
  const { repo, sha } = bareRepoWithCommit();
  const stdin = `${ZERO} ${sha} refs/heads/main\n`;

  const passNdh = fakeNdh({ exit: 0, output: "All Workflows finished successfully" });
  const pass = runHookScript(
    generatePreReceiveHook({ server: "http://h:1", repository: "t/a", ...passNdh.config }),
    { stdin, cwd: repo },
  );
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /CI passed for main — branch gate passed/);
  assert.equal(passNdh.calls().length, 1);
  assert.match(passNdh.calls()[0], /^dispatch --server http:\/\/h:1 --repository t\/a --event push --ref refs\/heads\/main$/);

  const failNdh = fakeNdh({ exit: 1, output: FAIL_OUT });
  const fail = runHookScript(
    generatePreReceiveHook({ server: "http://h:1", repository: "t/a", ...failNdh.config }),
    { stdin, cwd: repo },
  );
  assert.equal(fail.status, 1, "nonzero dispatch rejects the push");
  assert.match(fail.stderr, /CI failed for main \(exit 1\) — push rejected/);
  assert.match(fail.stderr, /\[ndh\] {3}\[app-ci \/ build\] Job Completed with Status: Failed/, "failed job named");
  assert.match(fail.stderr, /Workflow 1 Completed with Status: Failed/, "failed workflow named");
});

test("exec pre-receive: all-workflows-skipped (nonzero exit) accepts the push", () => {
  const { repo, sha } = bareRepoWithCommit();
  const skipNdh = fakeNdh({ exit: 1, output: SKIP_OUT });
  const r = runHookScript(
    generatePreReceiveHook({ server: "http://h:1", repository: "t/a", ...skipNdh.config }),
    { stdin: `${ZERO} ${sha} refs/heads/main\n`, cwd: repo },
  );
  assert.equal(r.status, 0, `skip must not reject: ${r.stderr}`);
  assert.match(r.stdout, /workflows skipped by filters for main — branch gate passed/);
});

test("exec pre-receive: multi-ref push is all-or-nothing — first failing branch rejects, later refs untested", () => {
  const { repo, sha } = bareRepoWithCommit();
  const stdin = `${ZERO} ${sha} refs/heads/main\n${ZERO} ${sha} refs/heads/dev\n`;

  const failNdh = fakeNdh({ exit: 1, output: FAIL_OUT });
  const fail = runHookScript(
    generatePreReceiveHook({ server: "http://h:1", repository: "t/a", ...failNdh.config }),
    { stdin, cwd: repo },
  );
  assert.equal(fail.status, 1);
  assert.equal(failNdh.calls().length, 1, "gate stops at the first failing branch");

  const passNdh = fakeNdh({ exit: 0 });
  const pass = runHookScript(
    generatePreReceiveHook({ server: "http://h:1", repository: "t/a", ...passNdh.config }),
    { stdin, cwd: repo },
  );
  assert.equal(pass.status, 0);
  assert.equal(passNdh.calls().length, 2, "both branches dispatched when passing");
  assert.match(passNdh.calls()[1], /--ref refs\/heads\/dev$/);
});

test("exec pre-receive: tag pushes and branch deletions are not gated and dispatch nothing", () => {
  const { repo, sha } = bareRepoWithCommit();
  const failNdh = fakeNdh({ exit: 1, output: FAIL_OUT }); // even a failing ndh cannot reject: it is never called
  const r = runHookScript(
    generatePreReceiveHook({ server: "http://h:1", repository: "t/a", ...failNdh.config }),
    { stdin: `${ZERO} ${sha} refs/tags/v1\n${sha} ${ZERO} refs/heads/old\n`, cwd: repo },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(failNdh.calls().length, 0, "no dispatch for tags or deletions");
});

test("exec post-receive: multi-branch dispatch, tags and deletions skipped, never fails the push", () => {
  const { repo, sha } = bareRepoWithCommit();
  const ndh = fakeNdh({ exit: 0 });
  const r = runHookScript(generateHook({ server: "http://h:1", repository: "t/a", ...ndh.config }), {
    stdin: `${ZERO} ${sha} refs/heads/main\n${ZERO} ${sha} refs/tags/v1\n${sha} ${ZERO} refs/heads/old\n${ZERO} ${sha} refs/heads/dev\n`,
    cwd: repo,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ndh.calls().length, 2, "one dispatch per pushed branch; tag + deletion skipped");
  assert.match(ndh.calls()[0], /--ref refs\/heads\/main$/);
  assert.match(ndh.calls()[1], /--ref refs\/heads\/dev$/);
  assert.match(r.stdout, /dispatched main/);
  assert.match(r.stdout, /dispatched dev/);
});

test("exec pre-push: local mode — pass allows, fail blocks (exit 1), skip allows", () => {
  const { repo, sha } = workingRepoWithCommit();
  const stdin = `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`;

  const passNdh = fakeNdh({ exit: 0 });
  const pass = runHookScript(generatePrePushHook({ repository: "t/a", ...passNdh.config }), { stdin, cwd: repo });
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(passNdh.calls()[0], /^run --repository t\/a --event push --ref refs\/heads\/main$/, "local ndh run mode");

  const failNdh = fakeNdh({ exit: 1, output: FAIL_OUT });
  const fail = runHookScript(generatePrePushHook({ repository: "t/a", ...failNdh.config }), { stdin, cwd: repo });
  assert.equal(fail.status, 1, "failing CI blocks the push");
  assert.match(fail.stderr, /CI failed for main \(exit 1\) — push blocked/);

  const skipNdh = fakeNdh({ exit: 1, output: SKIP_OUT });
  const skip = runHookScript(generatePrePushHook({ repository: "t/a", ...skipNdh.config }), { stdin, cwd: repo });
  assert.equal(skip.status, 0, "filter skip never blocks");
  assert.match(skip.stdout, /workflows skipped by filters for main — branch gate passed/);
});

test("exec pre-push: --server mode dispatches instead of running locally", () => {
  const { repo, sha } = workingRepoWithCommit();
  const ndh = fakeNdh({ exit: 0 });
  const r = runHookScript(generatePrePushHook({ server: "http://h:1", repository: "t/a", ...ndh.config }), {
    stdin: `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`,
    cwd: repo,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(ndh.calls()[0], /^dispatch --server http:\/\/h:1 --repository t\/a --event push --ref refs\/heads\/main$/);
});

test("exec pre-push: empty stdin (nothing to push) is a silent no-op success", () => {
  const { repo } = workingRepoWithCommit();
  const ndh = fakeNdh({ exit: 1, output: FAIL_OUT });
  const r = runHookScript(generatePrePushHook({ repository: "t/a", ...ndh.config }), { stdin: "", cwd: repo });
  assert.equal(r.status, 0);
  assert.equal(ndh.calls().length, 0);
});

test("exec pre-push: deletions and tags pass through untested; multi-ref stops at first failure", () => {
  const { repo, sha } = workingRepoWithCommit();

  const skipNdh = fakeNdh({ exit: 1, output: FAIL_OUT });
  const skip = runHookScript(generatePrePushHook({ repository: "t/a", ...skipNdh.config }), {
    stdin: `(delete) ${ZERO} refs/heads/old ${sha}\nrefs/tags/v1 ${sha} refs/tags/v1 ${ZERO}\n`,
    cwd: repo,
  });
  assert.equal(skip.status, 0, "delete + tag pushes never run CI");
  assert.equal(skipNdh.calls().length, 0);

  const multiNdh = fakeNdh({ exit: 1, output: FAIL_OUT });
  const multi = runHookScript(generatePrePushHook({ repository: "t/a", ...multiNdh.config }), {
    stdin: `refs/heads/main ${sha} refs/heads/main ${ZERO}\nrefs/heads/dev ${sha} refs/heads/dev ${ZERO}\n`,
    cwd: repo,
  });
  assert.equal(multi.status, 1, "one failing ref blocks the push");
  assert.equal(multiNdh.calls().length, 1, "stops at the first failure");
});

test("exec post-commit: exits 0 whether CI passes, fails, or skips — and reports each verdict", () => {
  const { repo } = workingRepoWithCommit();

  const passNdh = fakeNdh({ exit: 0 });
  const pass = runHookScript(generatePostCommitHook({ repository: "t/a", ...passNdh.config }), { cwd: repo });
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /advisory CI passed for commit/);
  assert.match(passNdh.calls()[0], /^run --repository t\/a --event push --ref refs\/heads\/(main|master)$/, "current branch ref passed");

  const failNdh = fakeNdh({ exit: 1, output: FAIL_OUT });
  const fail = runHookScript(generatePostCommitHook({ repository: "t/a", ...failNdh.config }), { cwd: repo });
  assert.equal(fail.status, 0, "a failing advisory run NEVER fails the hook");
  assert.match(fail.stderr, /advisory CI FAILED for commit .* — the commit itself stands/);
  assert.match(fail.stderr, /Job Completed with Status: Failed/, "failed job named");

  const skipNdh = fakeNdh({ exit: 1, output: SKIP_OUT });
  const skip = runHookScript(generatePostCommitHook({ repository: "t/a", ...skipNdh.config }), { cwd: repo });
  assert.equal(skip.status, 0);
  assert.match(skip.stdout, /workflows skipped by filters for commit/);
});

test("exec post-commit: detached HEAD runs without a --ref and still exits 0", () => {
  const { repo, sha } = workingRepoWithCommit();
  spawnSync("git", ["-C", repo, "checkout", "-q", "--detach", sha]);
  const ndh = fakeNdh({ exit: 0 });
  const r = runHookScript(generatePostCommitHook({ repository: "t/a", ...ndh.config }), { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ndh.calls()[0], "run --repository t/a --event push", "no --ref when detached");
});

// ---------- executed hooks: the missing-install loud-fail (#133) ----------

/** An invocation whose entry is gone — the moved/deleted-install scenario. */
const GONE = { ndhNode: process.execPath, ndhEntry: "/no/such/ndh-entry.js" };

test("exec loud-fail: pre-receive with a missing entry rejects the push (exit 97, unmissable error)", () => {
  const { repo, sha } = bareRepoWithCommit();
  const r = runHookScript(generatePreReceiveHook({ server: "http://h:1", repository: "t/a", ...GONE }), {
    stdin: `${ZERO} ${sha} refs/heads/main\n`,
    cwd: repo,
  });
  assert.equal(r.status, NDH_MISSING_EXIT, "the gate fails closed");
  assert.match(r.stderr, /ERROR: the ndh install this pre-receive hook points to is gone/);
  assert.match(r.stderr, /entry: \/no\/such\/ndh-entry\.js/, "the dead path is named");
  assert.match(r.stderr, /REJECTED \(fail closed\)/);
  assert.match(r.stderr, /re-run 'ndh hook install'/, "the fix is named");
  assert.ok(r.stderr.split("\n").filter((l) => l.includes("[ndh]")).length >= 6, "multi-line, not one buried line");
});

test("exec loud-fail: pre-push with a missing entry blocks the push (exit 97)", () => {
  const { repo, sha } = workingRepoWithCommit();
  const r = runHookScript(generatePrePushHook({ repository: "t/a", ...GONE }), {
    stdin: `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`,
    cwd: repo,
  });
  assert.equal(r.status, NDH_MISSING_EXIT);
  assert.match(r.stderr, /ERROR: the ndh install this pre-push hook points to is gone/);
  assert.match(r.stderr, /BLOCKED \(fail closed\)/);
});

test("exec loud-fail: post-receive with a missing entry shouts but lets the push stand (exit 0)", () => {
  const { repo, sha } = bareRepoWithCommit();
  const r = runHookScript(generateHook({ server: "http://h:1", repository: "t/a", ...GONE }), {
    stdin: `${ZERO} ${sha} refs/heads/main\n`,
    cwd: repo,
  });
  assert.equal(r.status, 0, "an advisory type cannot retroactively fail the push");
  assert.match(r.stderr, /ERROR: the ndh install this post-receive hook points to is gone/);
  assert.match(r.stderr, /CI was NOT dispatched for this push/, "the silent-loss failure mode is now loud");
  assert.doesNotMatch(r.stdout, /dispatched main/, "no false success line");
});

test("exec loud-fail: post-commit with a missing entry shouts but never fails the commit (exit 0)", () => {
  const { repo } = workingRepoWithCommit();
  const r = runHookScript(generatePostCommitHook({ repository: "t/a", ...GONE }), { cwd: repo });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /ERROR: the ndh install this post-commit hook points to is gone/);
  assert.match(r.stderr, /Advisory CI did not run for this commit/);
});

test("exec loud-fail: a missing node binary trips the same guard (exit 97 on the gate)", () => {
  const { repo, sha } = bareRepoWithCommit();
  const entryOnly = fakeNdh({ exit: 0 }); // entry exists; node does not
  const r = runHookScript(
    generatePreReceiveHook({
      server: "http://h:1",
      repository: "t/a",
      ndhNode: "/no/such/node",
      ndhEntry: entryOnly.config.ndhEntry,
    }),
    { stdin: `${ZERO} ${sha} refs/heads/main\n`, cwd: repo },
  );
  assert.equal(r.status, NDH_MISSING_EXIT);
  assert.match(r.stderr, /node: {2}\/no\/such\/node/, "the dead node path is named");
  assert.equal(entryOnly.calls().length, 0, "nothing is invoked past the guard");
});

// ---------- installHook: types, validation, client installs ----------

test("installHook: unknown --type fails with the valid list, before touching anything", async () => {
  await assert.rejects(
    () => installHook(bareRepo(), { type: "post-merge", server: "http://h:4949" }),
    /unknown hook type: post-merge — valid types: post-receive, pre-receive, pre-push, post-commit/,
  );
});

test("installHook: server types demand --server; client types run locally without it", async () => {
  await assert.rejects(() => installHook(bareRepo(), { type: "post-receive" }), /--type post-receive.*--server/);
  await assert.rejects(() => installHook(bareRepo(), { type: "pre-receive" }), /--type pre-receive.*--server/);
  // pre-push without --server is the local-run mode, not an error.
  const repo = workingRepo();
  await installHook(repo, { type: "pre-push" });
  assert.ok(readFileSync(join(repo, ".git", "hooks", "pre-push"), "utf8").includes('"$NDH_ENTRY" run'));
});

test("installHook: --type pre-receive writes an executable gate into a bare repo", async () => {
  const repo = nestedBareRepo(); // <tmp>/team/app.git
  await installHook(repo, { type: "pre-receive", server: "http://hub:4949" });
  const hookPath = join(repo, "hooks", "pre-receive");
  const content = readFileSync(hookPath, "utf8");
  assert.ok(content.includes(HOOK_MARKER));
  assert.ok(content.includes("REPO='team/app'"), "path-derived attribution applies to pre-receive too");
  assert.ok(content.includes("push rejected"));
  assert.equal(statSync(hookPath).mode & 0o777, 0o755);
});

test("installHook: pre-receive refuses a working repo; client types refuse a bare repo", async () => {
  await assert.rejects(
    () => installHook(workingRepo(), { type: "pre-receive", server: "http://h:4949" }),
    /not a bare git repository/,
  );
  await assert.rejects(() => installHook(bareRepo(), { type: "pre-push" }), /not a working checkout.*client-side/);
  await assert.rejects(() => installHook(bareRepo(), { type: "post-commit" }), /not a working checkout/);
});

test("installHook: client types refuse a plain dir and a subdirectory of a repo", async () => {
  const plain = mkdtempSync(join(tmpdir(), "ndh-hook-plainc-"));
  await assert.rejects(() => installHook(plain, { type: "post-commit" }), /not a working checkout/);
  const repo = workingRepo();
  const sub = join(repo, "src");
  mkdirSync(sub);
  await assert.rejects(
    () => installHook(sub, { type: "pre-push" }),
    /not a working checkout/,
    "a subdir's hooks would belong to the parent repo",
  );
});

test("installHook: --type post-commit installs into .git/hooks with 0755 and exit-0 tail", async () => {
  const repo = workingRepo();
  await installHook(repo, { type: "post-commit", workflow: "ci.yml" });
  const hookPath = join(repo, ".git", "hooks", "post-commit");
  const content = readFileSync(hookPath, "utf8");
  assert.ok(content.includes(HOOK_MARKER));
  assert.ok(content.includes("WORKFLOW='ci.yml'"));
  assert.ok(content.trimEnd().endsWith("exit 0"));
  assert.equal(statSync(hookPath).mode & 0o777, 0o755);
});

test("installHook: client attribution prefers the origin remote, falls back to the path (#104)", async () => {
  const repo = workingRepo();
  spawnSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: repo });
  await installHook(repo, { type: "pre-push" });
  const fromOrigin = readFileSync(join(repo, ".git", "hooks", "pre-push"), "utf8");
  assert.ok(fromOrigin.includes("REPO='acme/widget'"), "origin remote wins");

  const noOrigin = workingRepo(); // <tmp>/ndh-hook-work-XXX, no origin
  await installHook(noOrigin, { type: "pre-push" }, { originSlug: () => null });
  const fromPath = readFileSync(join(noOrigin, ".git", "hooks", "pre-push"), "utf8");
  assert.match(fromPath, /REPO='[^']+\/ndh-hook-work[^']*'/, "path-derived two-part fallback");
});

test("installHook: explicit --repository beats the origin remote for client types", async () => {
  const repo = workingRepo();
  spawnSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: repo });
  await installHook(repo, { type: "post-commit", repository: "team/override" });
  assert.ok(readFileSync(join(repo, ".git", "hooks", "post-commit"), "utf8").includes("REPO='team/override'"));
});

test("installHook: marker/--force semantics apply per hook file (pre-push shown)", async () => {
  const repo = workingRepo();
  const hookPath = join(repo, ".git", "hooks", "pre-push");
  writeFileSync(hookPath, "#!/bin/sh\necho hand-written pre-push\n", { mode: 0o755 });

  await assert.rejects(
    () => installHook(repo, { type: "pre-push" }),
    /refusing to overwrite an existing pre-push hook.*--force/,
  );
  assert.ok(readFileSync(hookPath, "utf8").includes("hand-written"), "untouched without --force");

  await installHook(repo, { type: "pre-push", force: true });
  assert.ok(readFileSync(hookPath, "utf8").includes(HOOK_MARKER), "--force replaces");
  // Managed now: reinstall without --force succeeds (regeneration path).
  await installHook(repo, { type: "pre-push", server: "http://hub:4949" });
  assert.ok(readFileSync(hookPath, "utf8").includes("HUB='http://hub:4949'"));
});

test("installHook: hook types coexist — installing pre-receive leaves post-receive alone", async () => {
  const repo = bareRepo();
  await installHook(repo, { server: "http://hub:4949" }); // default post-receive
  await installHook(repo, { type: "pre-receive", server: "http://hub:4949" });
  assert.ok(readFileSync(join(repo, "hooks", "post-receive"), "utf8").includes("dispatched"));
  assert.ok(readFileSync(join(repo, "hooks", "pre-receive"), "utf8").includes("push rejected"));
});

test("installHook: the isWorkingRepoRoot/hooksPath seams are honored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ndh-hook-clientstub-"));
  const hooks = join(dir, "custom-hooks");
  await installHook(dir, { type: "post-commit" }, {
    isWorkingRepoRoot: () => true,
    hooksPath: () => hooks,
    originSlug: () => "stub/repo",
  });
  assert.ok(readFileSync(join(hooks, "post-commit"), "utf8").includes("REPO='stub/repo'"));
});

// ---------- default git seams (real repos) ----------

test("gitIsWorkingRepoRoot: root true; bare, subdir, and plain dir false", () => {
  const repo = workingRepo();
  assert.equal(__test.gitIsWorkingRepoRoot(repo), true);
  const sub = join(repo, "nested");
  mkdirSync(sub);
  assert.equal(__test.gitIsWorkingRepoRoot(sub), false, "subdir of a repo is not the root");
  assert.equal(__test.gitIsWorkingRepoRoot(bareRepo()), false);
  assert.equal(__test.gitIsWorkingRepoRoot(mkdtempSync(join(tmpdir(), "ndh-hook-plain2-"))), false);
});

test("gitHooksPath: resolves the checkout's hooks dir; null outside a repo", () => {
  const repo = workingRepo();
  const hooks = __test.gitHooksPath(repo);
  assert.ok(hooks && hooks.endsWith(join(".git", "hooks")), `got: ${hooks}`);
  assert.equal(__test.gitHooksPath(mkdtempSync(join(tmpdir(), "ndh-hook-plain3-"))), null);
});

// ---------- CLI wiring (real subprocess) ----------

test("cli: `ndh hook` prints help and exits 0", async () => {
  const r = await runCli(["hook"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout + r.stderr, /a push or commit triggers CI/);
});

test("cli: `ndh hook install` without --server fails for the default server type (exit 1)", async () => {
  const r = await runCli(["hook", "install", bareRepo()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[ndh\].*--type post-receive.*pass --server/);
});

test("cli: `ndh hook install --type pre-receive` writes the gate hook (exit 0)", async () => {
  const repo = bareRepo();
  const r = await runCli(["hook", "install", repo, "--type", "pre-receive", "--server", "http://hub:4949"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /installed pre-receive hook/);
  assert.match(r.stderr, /a failing workflow rejects the push/);
  assert.ok(readFileSync(join(repo, "hooks", "pre-receive"), "utf8").includes("push rejected"));
});

test("cli: `ndh hook install --type pre-push` without --server installs the local-run gate", async () => {
  const repo = workingRepo();
  const r = await runCli(["hook", "install", repo, "--type", "pre-push"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /installed pre-push hook/);
  assert.match(r.stderr, /CI runs locally via `ndh run`/);
  assert.ok(readFileSync(join(repo, ".git", "hooks", "pre-push"), "utf8").includes('"$NDH_ENTRY" run --repository'));
});

test("cli: `ndh hook install --type post-commit` reports the advisory nature", async () => {
  const repo = workingRepo();
  const r = await runCli(["hook", "install", repo, "--type", "post-commit"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /installed post-commit hook/);
  assert.match(r.stderr, /never blocked/);
});

test("cli: `ndh hook install --type bogus` fails with the valid type list (exit 1)", async () => {
  const r = await runCli(["hook", "install", bareRepo(), "--type", "bogus", "--server", "http://h:4949"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[ndh\].*unknown hook type: bogus/);
});

test("cli: `ndh hook install` writes the hook into a bare repo (exit 0)", async () => {
  const repo = bareRepo();
  const r = await runCli(["hook", "install", repo, "--server", "http://hub:4949", "-W", "ci.yml"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /installed post-receive hook/);
  assert.match(r.stderr, /derived from the repo path/, "install reports the derivation");
  const content = readFileSync(join(repo, "hooks", "post-receive"), "utf8");
  assert.ok(content.includes("HUB='http://hub:4949'"));
  assert.ok(content.includes("WORKFLOW='ci.yml'"));
  assert.ok(content.includes('--repository "$REPO"'), "generated dispatch carries the label");
});

test("cli: `ndh hook install --repository` plumbs the explicit slug into the hook", async () => {
  const repo = bareRepo();
  const r = await runCli(["hook", "install", repo, "--server", "http://hub:4949", "--repository", "acme/widget"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /repository: acme\/widget/);
  assert.doesNotMatch(r.stderr, /derived from the repo path/, "no derivation note for an explicit slug");
  const content = readFileSync(join(repo, "hooks", "post-receive"), "utf8");
  assert.ok(content.includes("REPO='acme/widget'"));
});

test("cli: `ndh hook install` on a non-bare path fails with a clear message (exit 1)", async () => {
  const r = await runCli(["hook", "install", workingRepo(), "--server", "http://hub:4949"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[ndh\].*not a bare git repository/);
});

// ---------- CLI wiring: invocation resolution shapes (#133) ----------

test("cli: hook install embeds this node + the resolved entry (direct-entry shape) (#133)", async () => {
  // `node dist/index.js hook install …` — exactly the documented from-source invocation.
  const repo = bareRepo();
  const r = await runCli(["hook", "install", repo, "--server", "http://hub:4949"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ndh: {8}\S/, "install summary reports the embedded invocation");
  const content = readFileSync(join(repo, "hooks", "post-receive"), "utf8");
  assert.ok(content.includes(`NDH_NODE=${shSingleQuote(process.execPath)}`), "absolute node embedded");
  assert.ok(content.includes(`NDH_ENTRY=${shSingleQuote(realpathSync(cliPath()))}`), "realpath'd entry embedded");
  assert.ok(!content.includes(" ndh dispatch"), "no bare ndh invocation remains");
});

test("cli: a bin-shim symlink install (npm-global / from-source ~/bin shape) embeds the real entry (#133)", async () => {
  // npm's unix bin and `ln -s dist/index.js ~/bin/ndh` both run the entry via a symlink whose
  // shebang finds node on PATH; argv[1] is the shim path and must be realpath'd through.
  const bin = mkdtempSync(join(tmpdir(), "ndh-shim-"));
  const shim = join(bin, "ndh");
  const realEntry = realpathSync(cliPath());
  symlinkSync(realEntry, shim);
  const repo = bareRepo();
  const r = spawnSync(shim, ["hook", "install", repo, "--server", "http://hub:4949"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const content = readFileSync(join(repo, "hooks", "post-receive"), "utf8");
  assert.ok(content.includes(`NDH_ENTRY=${shSingleQuote(realEntry)}`), "the symlink resolves to the real entry");
  assert.ok(!content.includes(shim), "the shim path itself is never embedded");
  assert.match(content, /NDH_NODE='\/[^']+'/, "an absolute node binary is embedded");
});

test("cli: --ndh overrides the embedded entry; a missing --ndh path fails before writing (exit 1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ndh-override-"));
  const custom = join(dir, "custom-entry.js");
  writeFileSync(custom, "// custom entry\n");
  const repo = bareRepo();
  const ok = await runCli(["hook", "install", repo, "--server", "http://hub:4949", "--ndh", custom]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /--ndh override/, "the summary marks the override");
  const content = readFileSync(join(repo, "hooks", "post-receive"), "utf8");
  assert.ok(content.includes(`NDH_ENTRY=${shSingleQuote(realpathSync(custom))}`), "override embedded, realpath'd");

  const repo2 = bareRepo();
  const bad = await runCli(["hook", "install", repo2, "--server", "http://hub:4949", "--ndh", "/no/such/entry.js"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--ndh path does not exist/);
  assert.throws(() => readFileSync(join(repo2, "hooks", "post-receive")), /ENOENT/, "nothing was written");
});
