/*
  Derive the Projects surface from run history. There is no project registry by
  design — any checkout can dispatch — so "which projects does this hub serve?"
  is answered purely from the runs the hub has recorded (each run carries owner/
  repo since #59). This module is pure: given runs, it groups them into projects
  and, within each, into the distinct workflows that project has run.

  The page's primary source is the hub's /api/local/projects endpoint, which
  aggregates the FULL run history hub-side (issue #90) with exactly these
  semantics. deriveProjects here is the same computation, used as the fallback
  against an older hub — fed the UNPAGED runs list, never one page.

  Run ids are monotonic (the engine assigns them in dispatch order), so "latest"
  is always the max id — no timestamp is needed to order runs, and the runs list
  carries none anyway.

  Honesty rule for grouping (issue #90): a row is always one exact recorded
  label, never a merge. `kind` classifies what the label really is — a real
  repo, a `local/<dir>` checkout slug (grouped only by directory name), or
  unattributed runs (`Unknown/Unknown` / missing halves) — so the UI can badge
  the row instead of presenting it as a genuine repository.
*/
import type { WorkflowRun } from "./api";
import { projectLabel } from "./format";

/** How honestly to present a derived project row. `planned` = a #113 placeholder with no runs yet. */
export type ProjectKind = "repo" | "local" | "unattributed" | "planned";

/**
 * Classify a run's attribution. `local` is #59's `local/<dir>` fallback slug
 * for checkouts without an origin remote. `unattributed` covers runs with no
 * usable attribution: the engine's `Unknown/Unknown`, or a missing half.
 */
export function projectKind(run: { owner?: string | null; repo?: string | null }): ProjectKind {
  const owner = run.owner?.trim();
  const repo = run.repo?.trim();
  if (!owner || !repo || owner === "Unknown" || repo === "Unknown") return "unattributed";
  if (owner === "local") return "local";
  return "repo";
}

/** Stable identity of a workflow across runs — its file, else its display name. */
export function workflowKey(run: WorkflowRun): string {
  return run.fileName || run.displayName || `run-${run.id}`;
}
export function workflowLabel(run: WorkflowRun): string {
  return run.displayName || run.fileName || `Run ${run.id}`;
}
/** Bare file name for the YAML link (strips the .github/workflows/ path). */
export function workflowFileName(run: WorkflowRun): string {
  const f = run.fileName;
  if (f) return f.split("/").pop() || f;
  return run.displayName || `run-${run.id}`;
}

export interface ProjectWorkflow {
  key: string;
  /** Bare file name, for display + the YAML preview link. */
  fileName: string;
  /** Human label (display name when present). */
  label: string;
  runCount: number;
  /** The most recent run of this workflow — the definition to preview. */
  latestRun: WorkflowRun;
  latestRunId: number;
}

/** What the wizard/CLI parsed out of the workflow YAML when a placeholder was created (#113). */
export interface PlannedInfo {
  workflowFileName: string | null;
  workflowName: string | null;
  events: string[];
  branches: string[];
  runsOn: string[];
  createdAt: number;
}

export interface Project {
  /** The exact recorded label — never a merged or invented name. */
  name: string;
  kind: ProjectKind;
  runCount: number;
  /** The project's most recent run overall (max id) — null on a `planned` row (no runs yet). */
  lastRun: WorkflowRun | null;
  lastRunId: number | null;
  workflows: ProjectWorkflow[];
  /** Present only on `planned` rows: the placeholder's parsed workflow facts. */
  planned?: PlannedInfo;
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(value);
}

const latestById = (runs: WorkflowRun[]): WorkflowRun => runs.reduce((a, b) => (b.id > a.id ? b : a));

const KIND_ORDER: Record<ProjectKind, number> = { repo: 0, planned: 1, local: 2, unattributed: 3 };

/**
 * Group runs into projects, and within each project into its distinct
 * workflows. Ordered: real repos first, then local checkout slugs, then
 * unattributed — alphabetical within each group (matches /api/local/projects).
 */
export function deriveProjects(runs: WorkflowRun[]): Project[] {
  const byProject = new Map<string, WorkflowRun[]>();
  for (const r of runs) pushInto(byProject, projectLabel(r), r);

  const projects: Project[] = [];
  for (const [name, projectRuns] of byProject) {
    const byWorkflow = new Map<string, WorkflowRun[]>();
    for (const r of projectRuns) pushInto(byWorkflow, workflowKey(r), r);

    const workflows: ProjectWorkflow[] = [...byWorkflow.entries()].map(([key, wfRuns]) => {
      const latestRun = latestById(wfRuns);
      return {
        key,
        fileName: workflowFileName(latestRun),
        label: workflowLabel(latestRun),
        runCount: wfRuns.length,
        latestRun,
        latestRunId: latestRun.id,
      };
    });
    workflows.sort((a, b) => a.label.localeCompare(b.label));

    const lastRun = latestById(projectRuns);
    projects.push({
      name,
      kind: projectKind(lastRun),
      runCount: projectRuns.length,
      lastRun,
      lastRunId: lastRun.id,
      workflows,
    });
  }
  projects.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
  return projects;
}
