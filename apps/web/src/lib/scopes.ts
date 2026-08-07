/*
  Scope organizing for the Settings page (issue #148). Secrets and variables each
  carry a `scope`: the literal `global`, or an owner/repo the value is pinned to.
  These pure helpers group and filter rows by that scope, and derive the add-form's
  project picker options from the known-projects aggregate — so the UI logic stays
  testable in isolation from React.

  Ordering rule everywhere: `global` first, then every other scope alphabetically,
  so the same familiar order shows in the group headers, the filter, and the picker.
*/

/** The filter sentinel meaning "show every scope" — never a real stored scope. */
export const ALL = "all";
/** The literal scope for values not pinned to any repository. */
export const GLOBAL = "global";

/** Order comparator: `global` sorts before everything, then alphabetical. */
export function compareScopes(a: string, b: string): number {
  if (a === b) return 0;
  if (a === GLOBAL) return -1;
  if (b === GLOBAL) return 1;
  return a.localeCompare(b);
}

/** The distinct scopes present across a list of rows, in display order. */
export function distinctScopes<T extends { scope: string }>(items: T[]): string[] {
  return [...new Set(items.map((i) => i.scope))].sort(compareScopes);
}

export interface ScopeGroup<T> {
  scope: string;
  items: T[];
}

/** Group rows under their scope, groups ordered global-first then alphabetical. */
export function groupByScope<T extends { scope: string }>(items: T[]): ScopeGroup<T>[] {
  const byScope = new Map<string, T[]>();
  for (const it of items) {
    const arr = byScope.get(it.scope);
    if (arr) arr.push(it);
    else byScope.set(it.scope, [it]);
  }
  return [...byScope.keys()]
    .sort(compareScopes)
    .map((scope) => ({ scope, items: byScope.get(scope)! }));
}

/** Narrow rows to one scope; the `ALL` sentinel keeps everything. */
export function filterByScope<T extends { scope: string }>(items: T[], scope: string): T[] {
  return scope === ALL ? items : items.filter((i) => i.scope === scope);
}

const SLUG = /^[^/\s]+\/[^/\s]+$/;

/**
 * owner/repo options for the add-form project picker, from the known-projects
 * aggregate (GET /api/local/projects, #91). Only `owner/name`-shaped labels
 * qualify — a bare label carries no repository half to scope against — so they
 * are deduped and sorted for the picker. Returns [] when the list is absent
 * (older hub), leaving only global + the typed "other" fallback.
 */
export function projectScopeOptions(projects: { name: string }[] | null): string[] {
  if (!projects) return [];
  return [...new Set(projects.map((p) => p.name).filter((n) => SLUG.test(n)))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Whether a typed repository scope is a well-formed `owner/name` (form validation). */
export function isRepoSlug(scope: string): boolean {
  return SLUG.test(scope);
}
