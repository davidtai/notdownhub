/*
  Derive the Projects surface from run history. There is no project registry by
  design — any checkout can dispatch — so "which projects does this hub serve?"
  is answered purely from the runs the hub has recorded (each run carries owner/
  repo since #59). This module is pure: given the runs list, it groups them into
  projects and, within each, into the distinct workflows that project has run.

  Run ids are monotonic (the engine assigns them in dispatch order), so "latest"
  is always the max id — no timestamp is needed to order runs, and the runs list
  carries none anyway.
*/
import type { WorkflowRun } from "./api";
import { projectLabel } from "./format";

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

export interface Project {
  name: string;
  runCount: number;
  /** The project's most recent run overall (max id). */
  lastRun: WorkflowRun;
  lastRunId: number;
  workflows: ProjectWorkflow[];
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

/** Group runs into projects, and within each project into its distinct workflows. */
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
    projects.push({ name, runCount: projectRuns.length, lastRun, lastRunId: lastRun.id, workflows });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}
