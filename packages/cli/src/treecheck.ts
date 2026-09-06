/**
 * Dispatch pre-flight for a `.git`-less working tree (issue #158).
 *
 * When the dispatch directory has no `.git`, Runner.Client cannot use `git ls-files`
 * and walks the tree itself. That walk stops on a dangling symlink and reports nothing,
 * so the run's checkout waits for a tree that never uploads and the runner stays busy.
 * `ndh dispatch` / `ndh run` scan such a tree first and refuse with the list of dangling
 * links instead of dispatching a run whose checkout cannot complete. A tree WITH `.git`
 * is not scanned: git ls-files enumerates the index and never touches symlink targets.
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** True when `.git` exists as a directory or a file (a git-worktree gitlink is a file). */
export function hasGitDir(root: string): boolean {
  return existsSync(join(root, ".git"));
}

/**
 * Walk `root` without following symlinks and return the ones that dangle, as paths relative
 * to `root`. A symlink dangles when stat (which follows it) fails with ENOENT (target gone),
 * ENOTDIR (a path component is not a directory), or ELOOP (a cycle). The scan stops once
 * `limit` links are collected, so a tree full of broken links does not build an unbounded list.
 */
export async function findDanglingSymlinks(root: string, limit = 20): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (found.length >= limit) return;
      const abs = join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) {
        try {
          await stat(abs);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") found.push(relPath);
        }
      } else if (ent.isDirectory()) {
        await walk(abs, relPath);
      }
    }
  };
  await walk(root, "");
  return found;
}
