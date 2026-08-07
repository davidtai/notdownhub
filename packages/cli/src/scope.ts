import { spawnSync } from "node:child_process";
import { fail } from "./lib.js";

/**
 * Scope resolution shared by `ndh secrets` and `ndh vars`. A scope is either the literal
 * "global" or an "<owner>/<name>" repo slug; repo scope overrides global at run time.
 */

export const GLOBAL_SCOPE = "global";

/** A `--repo [slug]` commander option value: an explicit slug, `true` (flag, use cwd), or absent. */
export type RepoOpt = string | boolean | undefined;

/** Owner/name slug of the current git repo's origin remote, or null when not in one. */
export function currentRepoSlug(cwd: string = process.cwd()): string | null {
  const r = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return null;
  const url = r.stdout.toString().trim();
  if (!url) return null;
  // git@github.com:owner/name.git  |  https://github.com/owner/name(.git)
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/** Resolve a `--repo [slug]` option to a scope. Absent → global; bare flag → current repo. */
export function scopeFromRepo(repo: RepoOpt): string {
  if (typeof repo === "string") return repo;
  if (repo === true) {
    const slug = currentRepoSlug();
    if (!slug) fail("not inside a git repo with an origin remote — pass --repo owner/name");
    return slug;
  }
  return GLOBAL_SCOPE;
}

/** Effective scopes for a run, in override order: global first, then the repo scope. */
export function runScopes(repoSlug: string | null): string[] {
  return repoSlug ? [GLOBAL_SCOPE, repoSlug] : [GLOBAL_SCOPE];
}
