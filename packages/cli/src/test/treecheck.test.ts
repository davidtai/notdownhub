import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDanglingSymlinks, hasGitDir } from "../treecheck.js";

/** A fresh empty temp dir for one test. */
function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ndh-treecheck-"));
}

test("findDanglingSymlinks: walks nested dirs and reports only the broken link", async () => {
  const root = tmp();
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(join(root, "a", "b", "real.txt"), "hi");
  // A valid link (target exists) must NOT be reported.
  symlinkSync(join(root, "a", "b", "real.txt"), join(root, "a", "ok.link"));
  // A dangling link nested two levels down must be reported, relative to root.
  symlinkSync("../../nope/gone.md", join(root, "a", "b", "bad.link"));

  const found = await findDanglingSymlinks(root);
  assert.deepEqual(found, ["a/b/bad.link"]);
});

test("findDanglingSymlinks: a valid symlink alone yields an empty list", async () => {
  const root = tmp();
  writeFileSync(join(root, "target.txt"), "x");
  symlinkSync(join(root, "target.txt"), join(root, "good.link"));
  assert.deepEqual(await findDanglingSymlinks(root), []);
});

test("findDanglingSymlinks: the limit caps the returned list", async () => {
  const root = tmp();
  for (let i = 0; i < 10; i++) symlinkSync("does-not-exist", join(root, `dead-${i}.link`));
  const found = await findDanglingSymlinks(root, 3);
  assert.equal(found.length, 3);
  for (const p of found) assert.match(p, /^dead-\d+\.link$/);
});

test("findDanglingSymlinks: a self-referential link (ELOOP) counts as dangling", async () => {
  const root = tmp();
  symlinkSync(join(root, "loop.link"), join(root, "loop.link"));
  assert.deepEqual(await findDanglingSymlinks(root), ["loop.link"]);
});

test("hasGitDir: true for a .git directory", () => {
  const root = tmp();
  mkdirSync(join(root, ".git"));
  assert.equal(hasGitDir(root), true);
});

test("hasGitDir: true for a .git file (a worktree gitlink)", () => {
  const root = tmp();
  writeFileSync(join(root, ".git"), "gitdir: /somewhere/else\n");
  assert.equal(hasGitDir(root), true);
});

test("hasGitDir: false when there is no .git at all", () => {
  const root = tmp();
  writeFileSync(join(root, "README.md"), "no git here");
  assert.equal(hasGitDir(root), false);
});
