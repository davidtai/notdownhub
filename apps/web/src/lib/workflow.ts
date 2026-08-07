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
