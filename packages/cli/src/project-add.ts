import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Command } from "commander";
import { currentRepoSlug } from "./scope.js";
import { projectSlug } from "./runcmd.js";
import { isValidSlug } from "./frontstore.js";
import { labelMatch, parseWorkflowInfo, type WorkflowInfo } from "./workflowinfo.js";

/*
  `ndh project add` (#113): the CLI twin of the web "Add project" wizard.

  Same contract, same store: read the workflow YAML (the mandatory file-open,
  CLI form), parse name / on: / branches / runs-on, check runs-on against the
  live fleet's labels, then create the placeholder through the hub's OWN
  /api/local/projects/placeholder route — never by writing the store file
  directly, so both surfaces stay behind one gate and one schema owner.

  The placeholder appears on the Projects page (and in `ndh projects`) as
  "planned" until the first real run with the same slug absorbs it.
*/

export interface ProjectAddOptions {
  workflow: string;
  repository?: string;
  server: string;
  cwd?: string;
}

interface AgentLike {
  labels?: string[];
}

/** The fleet's labels via the hub's agents endpoint, or null when unreadable (gate/network). */
async function fetchFleetLabels(base: string): Promise<string[] | null> {
  try {
    const res = await fetch(new URL("api/local/agents", base));
    if (!res.ok) return null;
    const agents = (await res.json()) as AgentLike[];
    if (!Array.isArray(agents)) return null;
    const labels = new Set<string>();
    for (const a of agents) for (const l of a.labels ?? []) labels.add(l);
    return [...labels];
  } catch {
    return null;
  }
}

/** Print the runs-on verdicts; returns how many labels nothing in the fleet would pick up. */
export function reportRunsOn(info: WorkflowInfo, fleetLabels: string[] | null, print = console.log): number {
  if (info.runsOn.length === 0) return 0;
  if (fleetLabels === null) {
    print(`  runs-on: ${info.runsOn.join(", ")} (fleet not readable from here — labels not checked)`);
    return 0;
  }
  let misses = 0;
  for (const label of info.runsOn) {
    const verdict = labelMatch(label, fleetLabels);
    if (verdict === "match") print(`  runs-on: ${label} — matched by the current fleet`);
    else if (verdict === "hosted") print(`  runs-on: ${label} — hosted label, mapped to the self-hosted fleet by default`);
    else if (verdict === "dynamic") print(`  runs-on: ${label} — resolved at run time, not checked`);
    else {
      print(`  warning: no runner in the current fleet matches runs-on '${label}'`);
      misses++;
    }
  }
  return misses;
}

/** The copy-paste setup lines for a slug, exactly what the web wizard shows. */
export function setupLines(server: string, slug: string): string[] {
  const repo = slug.split("/")[1] ?? slug;
  return [
    `ndh dispatch --server ${server} --repository ${slug}`,
    `ndh hook install /srv/git/${repo}.git --server ${server} --repository ${slug}`,
  ];
}

/** `ndh project add -W <yaml> [--repository owner/repo] --server <hub>`. Returns the exit code. */
export async function projectAddCmd(opts: ProjectAddOptions): Promise<number> {
  let text: string;
  try {
    text = await readFile(opts.workflow, "utf8");
  } catch (err) {
    console.error(`cannot read workflow file ${opts.workflow}: ${err}`);
    return 1;
  }
  const info = parseWorkflowInfo(text);
  if (!info.ok) {
    console.error(`${opts.workflow}: ${info.error}`);
    return 1;
  }

  const slug = opts.repository ?? projectSlug(currentRepoSlug(opts.cwd), opts.cwd);
  if (!isValidSlug(slug)) {
    console.error(`invalid project slug '${slug}' — pass --repository owner/repo`);
    return 1;
  }

  const base = opts.server.endsWith("/") ? opts.server : `${opts.server}/`;
  console.log(`workflow: ${info.name ?? basename(opts.workflow)} (${basename(opts.workflow)}, ${info.jobCount} job${info.jobCount === 1 ? "" : "s"})`);
  if (info.events.length) console.log(`  on: ${info.events.join(", ")}`);
  if (info.branches.length) console.log(`  branches: ${info.branches.join(", ")}`);
  reportRunsOn(info, await fetchFleetLabels(base));

  let res: Response;
  try {
    res = await fetch(new URL("api/local/projects/placeholder", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        workflowFileName: basename(opts.workflow),
        workflowName: info.name,
        events: info.events,
        branches: info.branches,
        runsOn: info.runsOn,
      }),
    });
  } catch (err) {
    console.error(`hub unreachable at ${opts.server}: ${err}`);
    return 1;
  }
  if (res.status === 403 || res.status === 401) {
    console.error("the hub refused: its local API is loopback-only. Run this on the hub machine.");
    return 1;
  }
  if (!res.ok) {
    console.error(`placeholder not created: hub returned ${res.status} ${await res.text().catch(() => "")}`);
    return 1;
  }

  console.log(`\nplanned project ${slug} registered — it shows on the Projects page until its first run.`);
  console.log("start the first run:");
  for (const line of setupLines(opts.server, slug)) console.log(`  ${line}`);
  return 0;
}

// ── ndh project alias (#114) ────────────────────────────────────────────────

export interface ProjectAliasOptions {
  project: string;
  jobKey: string;
  /** The display alias to set; ignored with --clear. */
  alias?: string;
  clear?: boolean;
  server: string;
}

/**
 * `ndh project alias <owner/repo> <job-key> <alias>` — set a job DISPLAY alias
 * through the hub's gated alias route (the same store the UI pencil writes).
 * The engine's job records are never touched: the alias is a display layer,
 * and `--clear` restores the original name everywhere. Returns the exit code.
 */
export async function projectAliasCmd(opts: ProjectAliasOptions): Promise<number> {
  if (!isValidSlug(opts.project)) {
    console.error(`invalid project slug '${opts.project}' — expected owner/repo`);
    return 1;
  }
  if (!opts.clear && !opts.alias?.trim()) {
    console.error("pass the alias to set, or --clear to restore the original name");
    return 1;
  }
  const base = opts.server.endsWith("/") ? opts.server : `${opts.server}/`;
  let res: Response;
  try {
    res = opts.clear
      ? await fetch(
          new URL(
            `api/local/job-aliases?project=${encodeURIComponent(opts.project)}&jobKey=${encodeURIComponent(opts.jobKey)}`,
            base,
          ),
          { method: "DELETE" },
        )
      : await fetch(new URL("api/local/job-aliases", base), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: opts.project, jobKey: opts.jobKey, alias: opts.alias }),
        });
  } catch (err) {
    console.error(`hub unreachable at ${opts.server}: ${err}`);
    return 1;
  }
  if (res.status === 403 || res.status === 401) {
    console.error("the hub refused: its local API is loopback-only. Run this on the hub machine.");
    return 1;
  }
  if (!res.ok) {
    console.error(`hub returned ${res.status} ${await res.text().catch(() => "")}`);
    return 1;
  }
  if (opts.clear) {
    const body = (await res.json().catch(() => ({}))) as { removed?: boolean };
    console.log(
      body.removed
        ? `alias cleared — '${opts.jobKey}' shows its original name again in ${opts.project}`
        : `no alias was set for '${opts.jobKey}' in ${opts.project}`,
    );
  } else {
    console.log(`job '${opts.jobKey}' in ${opts.project} now displays as '${opts.alias!.trim()}' (original kept, shown on hover)`);
  }
  return 0;
}

export function registerProjectAdd(program: Command): void {
  const project = program.command("project").description("manage a single project on the hub");
  project
    .command("add")
    .description("register a planned project from its workflow YAML, before its first run")
    .requiredOption("-W, --workflow <path>", "the .github/workflows YAML to parse (required — setup derives from it)")
    .option("--repository <owner/repo>", "project slug (default: derived from this checkout's origin remote)")
    .option("--server <url>", "hub base url", "http://localhost:4949")
    .action(async (opts: { workflow: string; repository?: string; server: string }) => {
      process.exitCode = await projectAddCmd(opts);
    });
  project
    .command("alias")
    .description("set a job display alias (the original job name is kept, never overridden)")
    .argument("<owner/repo>", "project the job belongs to")
    .argument("<job-key>", "the original job key from the workflow YAML (jobs.<key>)")
    .argument("[alias]", "display name to show; omit with --clear")
    .option("--clear", "remove the alias so the original name shows again")
    .option("--server <url>", "hub base url", "http://localhost:4949")
    .action(async (project_: string, jobKey: string, alias: string | undefined, opts: { clear?: boolean; server: string }) => {
      process.exitCode = await projectAliasCmd({ project: project_, jobKey, alias, clear: opts.clear, server: opts.server });
    });
}
