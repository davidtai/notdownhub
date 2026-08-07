/*
  Pure parsing of a GitHub Actions workflow's `on:` trigger block.

  Source of truth: the hub retains the full workflow YAML byte-for-byte on each
  run attempt (GET /_apis/v1/Message/workflow/run/<id>/attempts → attempt.workflow,
  verified empirically). The Projects view fetches that YAML and runs it through
  here to show, per workflow, the exact events it fires on and the branches it
  watches — no shadow store, no guessing.

  `on:` has three surface forms, all handled below:
    on: push                       # a single event, string
    on: [push, pull_request]       # a list of events
    on:                            # a map: event → filters (branches, types, cron…)
      push:
        branches: [main, "release/*"]
      pull_request:
        branches: main             # a scalar is legal too (one branch)
      schedule:
        - cron: "0 0 * * *"
      workflow_dispatch:           # null value = event with no filters

  Note on the YAML 1.1 "on → true" gotcha: some YAML parsers coerce the bare key
  `on` to the boolean `true`. The `yaml` library we use is YAML 1.2 (keeps "on"),
  but we defensively read a `true` key too so this stays correct regardless.
*/
import { parse as parseYaml } from "yaml";

export interface EventTrigger {
  /** The event name exactly as declared: push / pull_request / schedule / workflow_dispatch / … */
  event: string;
  /** `branches:` include filter (what's watched). */
  branches: string[];
  /** `branches-ignore:` exclude filter. */
  branchesIgnore: string[];
  /** `tags:` filter. */
  tags: string[];
  /** `paths:` filter. */
  paths: string[];
  /** Activity `types:` (e.g. pull_request opened/synchronize). */
  types: string[];
  /** `schedule:` cron expressions. */
  cron: string[];
}

export interface WorkflowTriggers {
  /** Every event the workflow declares, in file order, with its filters. */
  events: EventTrigger[];
  /** Union of branch include-filters across all events — the branches being watched. */
  branches: string[];
  /** true when the definition declares no parseable `on:` trigger. */
  empty: boolean;
}

const EMPTY: WorkflowTriggers = { events: [], branches: [], empty: true };

/** A YAML filter value is either a scalar (one entry) or a sequence. Normalize to string[]. */
function toStringArray(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** `schedule:` is a list of `{ cron: "…" }` maps; tolerate a single map too. */
function extractCron(v: unknown): string[] {
  const items = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
  const out: string[] = [];
  for (const it of items) {
    if (it && typeof it === "object") {
      const cron = (it as Record<string, unknown>).cron;
      if (typeof cron === "string") out.push(cron);
    }
  }
  return out;
}

function eventFromEntry(event: string, cfg: unknown): EventTrigger {
  const base: EventTrigger = {
    event,
    branches: [],
    branchesIgnore: [],
    tags: [],
    paths: [],
    types: [],
    cron: [],
  };
  if (event === "schedule") {
    base.cron = extractCron(cfg);
    return base;
  }
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const o = cfg as Record<string, unknown>;
    base.branches = toStringArray(o.branches);
    base.branchesIgnore = toStringArray(o["branches-ignore"]);
    base.tags = toStringArray(o.tags);
    base.paths = toStringArray(o.paths);
    base.types = toStringArray(o.types);
  }
  return base;
}

/** Parse a workflow YAML string into its trigger events + watched branches. Never throws. */
export function parseWorkflowTriggers(yamlText: string): WorkflowTriggers {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return EMPTY;
  }
  if (!doc || typeof doc !== "object") return EMPTY;

  const root = doc as Record<string, unknown>;
  // YAML 1.2 keeps "on"; the 1.1 boolean-coercion fallback surfaces as a "true" key.
  const on = root.on ?? root["true"];
  if (on == null) return EMPTY;

  let events: EventTrigger[] = [];
  if (typeof on === "string") {
    events = [eventFromEntry(on, null)];
  } else if (Array.isArray(on)) {
    events = on
      .filter((e): e is string => typeof e === "string")
      .map((e) => eventFromEntry(e, null));
  } else if (typeof on === "object") {
    events = Object.entries(on as Record<string, unknown>).map(([e, cfg]) => eventFromEntry(e, cfg));
  }

  if (events.length === 0) return EMPTY;

  const branches: string[] = [];
  for (const e of events) {
    for (const b of e.branches) if (!branches.includes(b)) branches.push(b);
  }

  return { events, branches, empty: false };
}

/** One-line human summary of an event's filters, e.g. `push`, `pull_request (opened)`, `schedule (0 0 * * *)`. */
export function eventSummary(e: EventTrigger): string {
  const parts: string[] = [];
  if (e.cron.length) parts.push(e.cron.join(", "));
  if (e.types.length) parts.push(e.types.join(", "));
  return parts.length ? `${e.event} (${parts.join("; ")})` : e.event;
}

// ── whole-file inspection for the Add-project wizard (#113) ─────────────────
// Mirrored by the CLI's packages/cli/src/workflowinfo.ts (`ndh project add`),
// the same deliberate web/CLI duplication pattern as the projects aggregation —
// a placeholder parses identically no matter which surface created it.

export interface WorkflowFileInfo {
  /** false when the YAML does not parse, is not a map, or declares no jobs. */
  ok: boolean;
  /** Why `ok` is false, for the user's eyes. */
  error: string | null;
  /** The workflow-level `name:`, or null. */
  name: string | null;
  triggers: WorkflowTriggers;
  /** Distinct `runs-on` labels across jobs, file order; `${{ … }}` kept verbatim. */
  runsOn: string[];
  jobCount: number;
}

const FILE_FAIL = (error: string): WorkflowFileInfo => ({
  ok: false,
  error,
  name: null,
  triggers: EMPTY,
  runsOn: [],
  jobCount: 0,
});

/** Collect a job's `runs-on` labels: scalar, list, or `{ group, labels }` runner-group form. */
function jobRunsOn(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (v && typeof v === "object") return toStringArray((v as Record<string, unknown>).labels);
  return [];
}

/**
 * Parse a workflow FILE for the Add-project wizard: triggers (via the #73
 * parser above) plus the workflow name and the runs-on labels to validate
 * against the fleet. Never throws — a bad file comes back as `ok: false` with
 * the reason.
 */
export function parseWorkflowFile(yamlText: string): WorkflowFileInfo {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    return FILE_FAIL(`Not valid YAML: ${(err as Error).message ?? err}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return FILE_FAIL("Not a workflow: the top level is not a map.");
  const root = doc as Record<string, unknown>;

  const jobs = root.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return FILE_FAIL("Not a workflow: it declares no jobs.");
  const jobEntries = Object.values(jobs as Record<string, unknown>);
  if (jobEntries.length === 0) return FILE_FAIL("Not a workflow: the jobs block is empty.");

  const runsOn: string[] = [];
  for (const job of jobEntries) {
    if (!job || typeof job !== "object") continue;
    for (const label of jobRunsOn((job as Record<string, unknown>)["runs-on"])) {
      if (!runsOn.includes(label)) runsOn.push(label);
    }
  }

  return {
    ok: true,
    error: null,
    name: typeof root.name === "string" ? root.name : null,
    triggers: parseWorkflowTriggers(yamlText),
    runsOn,
    jobCount: jobEntries.length,
  };
}

// ── runs-on vs the live fleet ────────────────────────────────────────────────

/** Hosted labels the hub's default platform mapping sends to the self-hosted fleet (platform.ts). */
export const HOSTED_LABELS = ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04", "macos-latest", "windows-latest"];

/** How a single `runs-on` label relates to the current fleet. */
export type LabelMatch =
  | "match" // some registered runner carries this label
  | "hosted" // a hosted label the hub's default mapping sends to the self-hosted fleet
  | "dynamic" // a ${{ … }} expression — resolvable only at run time
  | "none"; // nothing registered would pick this up

/** Classify a `runs-on` label against the fleet's labels (case-insensitive). */
export function labelMatch(label: string, fleetLabels: Iterable<string>): LabelMatch {
  if (label.includes("${{")) return "dynamic";
  const fleet = new Set([...fleetLabels].map((l) => l.toLowerCase()));
  if (fleet.has(label.toLowerCase())) return "match";
  if (HOSTED_LABELS.includes(label) && fleet.has("self-hosted")) return "hosted";
  return "none";
}

/** One job as declared in a workflow YAML: its stable key and its display `name:` (if any). */
export interface WorkflowJob {
  /** The `jobs.<key>` — the identity #114 display aliases are stored under. */
  key: string;
  /** The declared `name:`, else the key. Matrix `${{ … }}` names are kept verbatim. */
  name: string;
}

/**
 * The jobs a workflow YAML declares, in file order — the rename surface on the
 * Projects breakdown (#114). Returns [] when the YAML doesn't parse or has no
 * jobs map; never throws.
 */
export function workflowJobs(yamlText: string): WorkflowJob[] {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [];
  const jobs = (doc as Record<string, unknown>).jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return [];
  return Object.entries(jobs as Record<string, unknown>).map(([key, job]) => {
    const name = job && typeof job === "object" ? (job as Record<string, unknown>).name : undefined;
    return { key, name: typeof name === "string" ? name : key };
  });
}

/**
 * A best-effort `owner/repo` hint scraped from the YAML text (a github.com URL
 * or an explicit `repository:` value) to prefill the wizard's slug field.
 */
export function slugHint(yamlText: string): string | null {
  const url = yamlText.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[\s/"']|$)/);
  if (url) return `${url[1]}/${url[2]}`;
  const repo = yamlText.match(/\brepository:\s*['"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)['"]?/);
  return repo ? repo[1] : null;
}
