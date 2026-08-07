import { parse as parseYaml } from "yaml";
import { HOSTED_LABELS } from "./platform.js";

/*
  Workflow YAML inspection for `ndh project add` (#113): the CLI-side twin of
  the web app's parser (apps/web/src/lib/workflow.ts, from #73), extended with
  the workflow `name:` and the distinct `runs-on` labels across jobs. The two
  sides deliberately mirror each other (the same web/CLI duplication pattern as
  the projects aggregation) so a placeholder parses identically no matter which
  surface created it.

  `on:` has three surface forms, all handled: a scalar event, a list of events,
  and a map of event → filters. YAML 1.1 parsers coerce the bare key `on` to
  boolean true; the `yaml` library is 1.2 (keeps "on"), but the `true` key is
  read too, defensively.
*/

export interface WorkflowInfo {
  /** false when the YAML does not parse, is not a map, or declares no jobs. */
  ok: boolean;
  /** Why `ok` is false, for the operator's eyes. */
  error: string | null;
  /** The workflow-level `name:`, or null. */
  name: string | null;
  /** One summary per declared `on:` event, e.g. `push`, `schedule (0 0 * * *)`. */
  events: string[];
  /** Union of `branches:` include-filters across all events. */
  branches: string[];
  /** Distinct `runs-on` labels across jobs, file order; `${{ … }}` kept verbatim. */
  runsOn: string[];
  jobCount: number;
}

const FAIL = (error: string): WorkflowInfo => ({
  ok: false,
  error,
  name: null,
  events: [],
  branches: [],
  runsOn: [],
  jobCount: 0,
});

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

/** One-line summary of an event + its notable filters (matches the web's eventSummary). */
function summarize(event: string, cfg: unknown): { summary: string; branches: string[] } {
  if (event === "schedule") {
    const cron = extractCron(cfg);
    return { summary: cron.length ? `${event} (${cron.join(", ")})` : event, branches: [] };
  }
  let branches: string[] = [];
  let types: string[] = [];
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const o = cfg as Record<string, unknown>;
    branches = toStringArray(o.branches);
    types = toStringArray(o.types);
  }
  return { summary: types.length ? `${event} (${types.join(", ")})` : event, branches };
}

/** Collect a job's `runs-on` labels: scalar, list, or `{ group, labels }` runner-group form. */
function jobRunsOn(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (v && typeof v === "object") return toStringArray((v as Record<string, unknown>).labels);
  return [];
}

/** Parse a workflow YAML into the setup facts `ndh project add` needs. Never throws. */
export function parseWorkflowInfo(yamlText: string): WorkflowInfo {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    return FAIL(`not valid YAML: ${(err as Error).message ?? err}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return FAIL("not a workflow: top level is not a map");
  const root = doc as Record<string, unknown>;

  const jobs = root.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return FAIL("not a workflow: no jobs: block");
  const jobEntries = Object.values(jobs as Record<string, unknown>);
  if (jobEntries.length === 0) return FAIL("not a workflow: jobs: block is empty");

  const events: string[] = [];
  const branches: string[] = [];
  // YAML 1.2 keeps "on"; the 1.1 boolean-coercion fallback surfaces as a "true" key.
  const on = root.on ?? root["true"];
  if (typeof on === "string") {
    events.push(on);
  } else if (Array.isArray(on)) {
    for (const e of on) if (typeof e === "string") events.push(e);
  } else if (on && typeof on === "object") {
    for (const [event, cfg] of Object.entries(on as Record<string, unknown>)) {
      const s = summarize(event, cfg);
      events.push(s.summary);
      for (const b of s.branches) if (!branches.includes(b)) branches.push(b);
    }
  }

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
    events,
    branches,
    runsOn,
    jobCount: jobEntries.length,
  };
}

// ── runs-on vs the live fleet ────────────────────────────────────────────────

/** How a single `runs-on` label relates to the current fleet. */
export type LabelMatch =
  | "match" // some registered runner carries this label
  | "hosted" // a hosted label the hub's default mapping sends to the self-hosted fleet
  | "dynamic" // a ${{ … }} expression — resolvable only at run time
  | "none"; // nothing registered would pick this up

/**
 * Classify a `runs-on` label against the fleet's label sets. `hosted` mirrors
 * the hub's default platform mapping (platform.ts): every HOSTED_LABEL is sent
 * to `-self-hosted`, so it matches whenever any runner carries `self-hosted`.
 */
export function labelMatch(label: string, fleetLabels: Iterable<string>): LabelMatch {
  if (label.includes("${{")) return "dynamic";
  const fleet = new Set([...fleetLabels].map((l) => l.toLowerCase()));
  if (fleet.has(label.toLowerCase())) return "match";
  if ((HOSTED_LABELS as readonly string[]).includes(label) && fleet.has("self-hosted")) return "hosted";
  return "none";
}
