import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRepoSlug, generateHook, shSingleQuote, installHook, HOOK_MARKER, __test } from "../hook.js";
import { runCli } from "./helpers.js";

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

// ---------- shSingleQuote ----------

test("shSingleQuote: wraps plain values and escapes embedded single quotes", () => {
  assert.equal(shSingleQuote("http://hub:4949"), "'http://hub:4949'");
  // a value containing a quote closes/escapes/reopens: it's -> 'it'\''s'
  assert.equal(shSingleQuote("it's"), "'it'\\''s'");
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

test("generateHook: embeds server + repository, loops refs/heads/*, dispatches with --ref, no -W by default", () => {
  const script = generateHook({ server: "http://hub.local:4949", repository: "team/app" });
  assert.ok(script.startsWith("#!/bin/sh\n"), "POSIX sh shebang");
  assert.ok(script.includes(HOOK_MARKER), "carries the managed marker");
  assert.ok(script.includes("HUB='http://hub.local:4949'"), "single-quoted server url");
  assert.ok(script.includes("REPO='team/app'"), "single-quoted repository slug (#99)");
  assert.ok(script.includes("refs/heads/*)"), "only branch refs pass the case filter");
  assert.ok(script.includes('git --work-tree="$work" checkout -f "$new"'), "checks out the pushed tree");
  assert.ok(
    script.includes('ndh dispatch --server "$HUB" --repository "$REPO" --event push --ref "$ref"'),
    "dispatches per pushed ref with the project label baked in",
  );
  assert.ok(!script.includes("-W"), "no workflow flag when none configured");
  assert.ok(!script.includes("WORKFLOW="), "no WORKFLOW var when none configured");
});

test("generateHook: propagates the workflow flag when configured", () => {
  const script = generateHook({ server: "http://h:4949", repository: "t/a", workflow: ".github/workflows/ci.yml" });
  assert.ok(script.includes("WORKFLOW='.github/workflows/ci.yml'"), "single-quoted workflow var");
  assert.ok(
    script.includes('ndh dispatch --server "$HUB" --repository "$REPO" --event push --ref "$ref" -W "$WORKFLOW"'),
    "adds -W to the dispatch",
  );
});

test("generateHook: a server url or repository with a single quote stays single-quote-safe", () => {
  const script = generateHook({ server: "http://ho'st:4949", repository: "te'am/app" });
  assert.ok(script.includes("HUB='http://ho'\\''st:4949'"), "quote is escaped, not left dangling");
  assert.ok(script.includes("REPO='te'\\''am/app'"), "repository quote is escaped too");
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

// ---------- CLI wiring (real subprocess) ----------

test("cli: `ndh hook` prints help and exits 0", async () => {
  const r = await runCli(["hook"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout + r.stderr, /post-receive|trigger CI on push/);
});

test("cli: `ndh hook install` requires --server (exit 1)", async () => {
  const r = await runCli(["hook", "install", bareRepo()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /required option '--server/);
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
