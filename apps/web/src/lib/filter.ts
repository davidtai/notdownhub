import type { RunnerInfo, WorkflowRun } from "./api";
import { projectLabel, shortRef, STATE_LABEL, toState } from "./format";

/*
  Free-text pill filtering. Each saved pill (and the in-progress draft) is a plain
  search term; an item matches when EVERY term is a substring of its "haystack" —
  the lowercased join of the fields a pill is allowed to match. Terms combine with
  AND, matching operator intuition: "acme" + "ci" keeps only acme's CI runs.
*/

/** Searchable text for a run: project, workflow, branch, event, result/state, id. */
export function runHaystack(run: WorkflowRun): string {
  const state = toState(run.status, run.result);
  return [
    projectLabel(run),
    run.displayName,
    run.fileName,
    shortRef(run.ref),
    run.eventName,
    run.result,
    run.status,
    STATE_LABEL[state],
    `#${run.id}`,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Searchable text for a runner: name, labels, state, os, version. */
export function runnerHaystack(runner: RunnerInfo): string {
  return [runner.name, ...runner.labels, runner.state, runner.os, runner.version]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** True when every non-empty term is a substring of the haystack (AND semantics). */
export function matchesTerms(haystack: string, terms: string[]): boolean {
  return normalizeTerms(terms).every((t) => haystack.includes(t));
}

/** Keep only items whose haystack matches every term. No terms → the list passes through. */
export function filterByTerms<T>(
  items: T[],
  terms: string[],
  haystackOf: (item: T) => string,
): T[] {
  const active = normalizeTerms(terms);
  if (active.length === 0) return items;
  return items.filter((item) => {
    const hay = haystackOf(item);
    return active.every((t) => hay.includes(t));
  });
}

/** Trim, lowercase, and drop blank terms — the shared normalization for a pill/draft term. */
function normalizeTerms(terms: string[]): string[] {
  const out: string[] = [];
  for (const t of terms) {
    const term = t.trim().toLowerCase();
    if (term) out.push(term);
  }
  return out;
}
