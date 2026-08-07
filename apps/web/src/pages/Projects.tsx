import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TriangleAlert, ExternalLink, Trash2, GitBranch, Plus, CalendarClock, Pencil } from "lucide-react";
import {
  getAllRuns,
  getProjects,
  getWorkflowDefinition,
  getRunLastActivity,
  deleteProjectRuns,
  deleteProjectPlaceholder,
  probeDeleteProjectSupport,
  getJobAliases,
  aliasFor,
  type JobAlias,
} from "../lib/api";
import { usePoll } from "../lib/hooks";
import { deriveProjects, type Project, type ProjectWorkflow, summarizeWorkflows } from "../lib/projects";
import { parseWorkflowTriggers, eventSummary, workflowJobs, type WorkflowTriggers } from "../lib/workflow";
import { toState, relativeTime } from "../lib/format";
import { AppBar } from "../components/AppBar";
import { AddProject } from "../components/AddProject";
import { RenameJobDialog, type RenameTarget } from "../components/RenameJobDialog";
import { RerunButton } from "../components/RerunButton";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Tooltip } from "../components/ui/tooltip";
import { StatusIcon, StatePill } from "../components/StatusIcon";
import { Badge } from "../components/ui/badge";

const PROJECTS_INTERVAL = 4000;
// Re-probe for the delete backend periodically so Remove appears the moment #60 ships.
const CAPABILITY_INTERVAL = 15000;

export interface EnrichedWorkflow extends ProjectWorkflow {
  /** The latest known definition YAML for this workflow (null if the hub didn't retain it). */
  yaml: string | null;
  /** Parsed triggers, or null when there is no YAML to parse. */
  triggers: WorkflowTriggers | null;
}
export interface EnrichedProject extends Project {
  workflows: EnrichedWorkflow[];
  /** Real wall-clock time of the project's last run, or null when unknown. */
  lastActivity: string | null;
}

/**
 * Load the derived Projects surface from the FULL run history (issue #90):
 * prefer the hub-side aggregate (/api/local/projects — one page can never hide
 * a project), falling back to deriving the same list client-side from the
 * unpaged runs list on an older hub. Then, for each project, fetch the latest
 * definition per workflow (for branches/events + the YAML preview) and the
 * project's last-run time (from its job timelines).
 */
export async function loadProjects(): Promise<EnrichedProject[]> {
  const fromHub = await getProjects();
  const projects = fromHub ?? deriveProjects(await getAllRuns());
  return Promise.all(
    projects.map(async (p) => {
      // A planned placeholder (#113) has no runs — nothing to enrich from run history.
      if (p.kind === "planned" || p.lastRunId === null) return { ...p, workflows: [], lastActivity: null };
      const workflows = await Promise.all(
        p.workflows.map(async (w) => {
          const def = await getWorkflowDefinition(w.latestRunId);
          const triggers = def.yaml ? parseWorkflowTriggers(def.yaml) : null;
          return { ...w, yaml: def.yaml, triggers };
        }),
      );
      const lastActivity = await getRunLastActivity(p.lastRunId);
      return { ...p, workflows, lastActivity };
    }),
  );
}

export function Projects() {
  const projects = usePoll(loadProjects, PROJECTS_INTERVAL);
  const list = projects.data ?? [];

  // Feature-detect the run-deletion backend (#60). Until it exists, the Remove
  // control is not rendered at all — no button that errors when clicked.
  const removeCapability = usePoll(probeDeleteProjectSupport, CAPABILITY_INTERVAL);
  const canRemove = removeCapability.data === true;

  const [pending, setPending] = useState<EnrichedProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  // #114 job display aliases (front-owned display layer) + the rename dialog they feed.
  const aliasesPoll = usePoll(getJobAliases, 5000);
  const aliases = aliasesPoll.data ?? [];
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);

  async function confirmRemove() {
    if (!pending) return;
    setBusy(true);
    setRemoveError(null);
    const res = await deleteProjectRuns(pending.name);
    setBusy(false);
    if (res.ok) {
      setPending(null);
      projects.refresh();
    } else {
      setRemoveError(
        res.status === 404
          ? "Project removal isn't wired up yet — it ships with the run-deletion backend (#60)."
          : `Couldn't remove this project (HTTP ${res.status}).`,
      );
    }
  }

  function closeDialog() {
    setPending(null);
    setRemoveError(null);
  }

  return (
    <div className="min-h-full">
      <AppBar />

      <main className="mx-auto max-w-[1160px] px-4 py-6 sm:px-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-fg">Projects</h1>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              Every project this hub has run, derived from its full run history — with the
              workflows, branches, and events each one is watching.
            </p>
          </div>
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            <Plus size={14} aria-hidden />
            Add project
          </Button>
        </div>

        {projects.initial ? (
          <SkeletonCards />
        ) : projects.error && !projects.data ? (
          <ErrorState />
        ) : list.length === 0 ? (
          <EmptyState />
        ) : (
          <ProjectSections
            list={list}
            canRemove={canRemove}
            onRemove={setPending}
            onRefresh={projects.refresh}
            aliases={aliases}
            onRename={setRenameTarget}
          />
        )}
      </main>

      {pending && (
        <RemoveDialog
          project={pending}
          busy={busy}
          error={removeError}
          onCancel={closeDialog}
          onConfirm={confirmRemove}
        />
      )}

      {wizardOpen && <AddProject onClose={() => setWizardOpen(false)} onCreated={projects.refresh} />}

      {renameTarget && (
        <RenameJobDialog
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onChanged={aliasesPoll.refresh}
        />
      )}
    </div>
  );
}

/**
 * Repo-attributed projects render as the main list. `local/<dir>` slugs and
 * unattributed (`Unknown/Unknown`) runs are real recorded labels but not
 * verified repositories, so they live under their own clearly-labeled section
 * — each recorded label stays its own row, never merged into one fake project.
 */
function ProjectSections({
  list,
  canRemove,
  onRemove,
  onRefresh,
  aliases,
  onRename,
}: {
  list: EnrichedProject[];
  canRemove: boolean;
  onRemove: (p: EnrichedProject) => void;
  onRefresh: () => void;
  aliases: JobAlias[];
  onRename: (t: RenameTarget) => void;
}) {
  // Planned placeholders (#113) live in the main list — they are intended repos.
  const repos = list.filter((p) => p.kind === "repo" || p.kind === "planned");
  const other = list.filter((p) => p.kind !== "repo" && p.kind !== "planned");
  return (
    <>
      {repos.length > 0 && (
        <div className="flex flex-col gap-4">
          {repos.map((p) =>
            p.kind === "planned" ? (
              <PlannedCard key={p.name} project={p} onRemoved={onRefresh} />
            ) : (
              <ProjectCard key={p.name} project={p} canRemove={canRemove} onRemove={() => onRemove(p)} aliases={aliases} onRename={onRename} />
            ),
          )}
        </div>
      )}
      {other.length > 0 && (
        <section className={repos.length > 0 ? "mt-8" : undefined} aria-label="Local and unattributed runs">
          <h2 className="text-sm font-semibold text-fg">Local &amp; unattributed</h2>
          <p className="mb-3 mt-0.5 text-[12px] text-fg-muted">
            Runs without a verified repository. Local checkouts are grouped by their recorded
            directory slug; unattributed runs carry no project at all.
          </p>
          <div className="flex flex-col gap-4">
            {other.map((p) => (
              <ProjectCard key={p.name} project={p} canRemove={canRemove} onRemove={() => onRemove(p)} aliases={aliases} onRename={onRename} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** The honesty note shown on a non-repo card — says exactly how the grouping was made. */
const KIND_NOTE: Record<string, string | undefined> = {
  local:
    "Dispatched from a checkout without a git remote. Grouped by the recorded directory name — unrelated checkouts with the same name share this row.",
  unattributed:
    "These runs were recorded without project attribution and may come from unrelated checkouts.",
};

function ProjectCard({
  project,
  canRemove,
  onRemove,
  aliases,
  onRename,
}: {
  project: EnrichedProject;
  canRemove: boolean;
  onRemove: () => void;
  aliases: JobAlias[];
  onRename: (t: RenameTarget) => void;
}) {
  const state = toState(project.lastRun?.status, project.lastRun?.result);
  const when = relativeTime(project.lastActivity);
  const note = KIND_NOTE[project.kind];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <StatusIcon state={state} size={18} />
        <h2 className="truncate font-mono text-sm font-semibold text-fg">{project.name}</h2>
        {project.kind === "local" && <Badge variant="outline">local checkout</Badge>}
        {project.kind === "unattributed" && <Badge variant="outline">unattributed</Badge>}
        <StatePill state={state} />
        <WorkflowChip workflows={project.workflows} />
        <span className="text-[12px] text-fg-muted">
          {project.runCount} {project.runCount === 1 ? "run" : "runs"}
        </span>
        {when ? (
          <span className="tnum text-[12px] text-fg-subtle">last {when}</span>
        ) : state === "skipped" ? (
          // A filter-skipped last run has no job timeline, so there is no real time to
          // show — say so explicitly instead of leaving the slot blank (#140).
          <span className="text-[12px] text-fg-subtle" title="Last run was skipped — no jobs ran">
            last run skipped
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          <Link
            to={`/?project=${encodeURIComponent(project.name)}`}
            className="inline-flex h-8 items-center rounded-md px-3 text-xs font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
          >
            View runs
          </Link>
          {/* Rendered only when the run-deletion backend (#60) is present — no dead button. */}
          {canRemove && (
            <Button
              variant="ghost"
              size="sm"
              className="text-fail hover:bg-fail/10 hover:text-fail"
              aria-label={`Remove project ${project.name}`}
              onClick={onRemove}
            >
              <Trash2 size={14} />
              Remove
            </Button>
          )}
        </div>
      </div>

      {note && <p className="border-b border-line-muted px-4 py-2 text-[12px] text-fg-subtle">{note}</p>}

      <ul className="divide-y divide-line-muted">
        {project.workflows.map((w) => (
          <li key={w.key} className="px-4 py-3">
            <WorkflowRow workflow={w} project={project.name} aliases={aliases} onRename={onRename} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function WorkflowRow({
  workflow,
  project,
  aliases,
  onRename,
}: {
  workflow: EnrichedWorkflow;
  project: string;
  aliases: JobAlias[];
  onRename: (t: RenameTarget) => void;
}) {
  const { triggers } = workflow;
  const navigate = useNavigate();
  // #114: the workflow's jobs (from the retained YAML) are the rename surface here.
  const jobs = workflow.yaml ? workflowJobs(workflow.yaml) : [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <StatusIcon
          state={toState(workflow.latestRun?.status, workflow.latestRun?.result)}
          size={14}
        />
        {/* Opens the retained YAML in a NEW TAB — a real navigation, not a router link. */}
        <a
          href={`/projects/workflow/${workflow.latestRunId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[13px] font-medium text-accent hover:underline"
        >
          {workflow.fileName}
          <ExternalLink size={12} className="shrink-0" aria-hidden />
        </a>
        <span className="text-[11px] text-fg-subtle">
          {workflow.runCount} {workflow.runCount === 1 ? "run" : "runs"}
        </span>
        {/* Force run (#113): replays the workflow's LATEST run through the #112 re-run
            path (new attempt, correct platform + localcheckout wiring). A hub refusal
            (tree not retained) surfaces verbatim in the button's tooltip. */}
        <RerunButton
          runId={workflow.latestRunId}
          action="Force run"
          busyAction="Starting…"
          hint="Run this workflow now — replays its latest run as a new attempt on the fleet"
          variant="ghost"
          className="ml-auto"
          onDone={() => navigate(`/runs/${workflow.latestRunId}`)}
        />
      </div>

      {jobs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-muted">
          <span className="eyebrow mr-0.5">Jobs</span>
          {jobs.map((j) => {
            const alias = aliasFor(aliases, project, j.key);
            return (
              <span
                key={j.key}
                className="inline-flex items-center gap-0.5 rounded-md border border-line px-1.5 py-0.5"
                title={alias ? `Original: ${j.name} (${j.key})` : `jobs.${j.key}`}
              >
                <span className="font-mono text-[11px] text-fg">{alias ?? j.name}</span>
                <button
                  onClick={() => onRename({ project, jobKey: j.key, original: j.name, alias })}
                  aria-label={`Rename job ${j.name} in ${project}`}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-raised hover:text-fg"
                >
                  <Pencil size={10} aria-hidden />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {workflow.yaml === null ? (
        <p className="text-[12px] text-fg-subtle">Workflow definition not retained for the latest run.</p>
      ) : triggers && !triggers.empty ? (
        <>
          {/* Exact events the YAML fires on, with their filters. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="eyebrow mr-0.5">On</span>
            {triggers.events.map((e) => (
              <Badge key={e.event} variant="outline">
                {eventSummary(e)}
              </Badge>
            ))}
          </div>
          {/* Branches being watched (union of push/pull_request branch filters). */}
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-muted">
            <span className="eyebrow mr-0.5">Branches</span>
            {triggers.branches.length > 0 ? (
              triggers.branches.map((b) => (
                <span key={b} className="inline-flex items-center gap-1 font-mono text-[11px]">
                  <GitBranch size={11} className="text-fg-subtle" />
                  {b}
                </span>
              ))
            ) : (
              <span className="text-[12px] text-fg-subtle">all branches</span>
            )}
          </div>
        </>
      ) : (
        <p className="text-[12px] text-fg-subtle">No triggers declared in the workflow definition.</p>
      )}
    </div>
  );
}

/**
 * A #113 planned placeholder: registered from its workflow YAML, no runs yet.
 * Shows what the placeholder parsed (workflow, events, branches, runs-on) and
 * the dispatch command that starts the first run — which absorbs this card
 * into a real project row. Removing it deletes only the placeholder.
 */
function PlannedCard({ project, onRemoved }: { project: EnrichedProject; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const p = project.planned;
  const hubUrl =
    typeof window !== "undefined" ? `${window.location.protocol}//${window.location.host}` : "http://your-hub:4949";

  async function remove() {
    if (busy) return;
    setBusy(true);
    await deleteProjectPlaceholder(project.name);
    setBusy(false);
    onRemoved();
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <CalendarClock size={18} className="text-fg-subtle" aria-hidden />
        <h2 className="truncate font-mono text-sm font-semibold text-fg">{project.name}</h2>
        <Badge variant="outline">planned</Badge>
        <span className="text-[12px] text-fg-muted">no runs yet</span>
        <div className="ml-auto flex items-center gap-1.5">
          {/* No runs exist, so there is nothing to force-run — disabled, honestly. */}
          <Tooltip label="No runs yet — start the first one with the dispatch command below" side="bottom">
            <Button variant="ghost" size="sm" disabled aria-label={`Force run ${project.name}`}>
              Force run
            </Button>
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            className="text-fail hover:bg-fail/10 hover:text-fail"
            aria-label={`Remove planned project ${project.name}`}
            onClick={remove}
            disabled={busy}
          >
            <Trash2 size={14} />
            {busy ? "Removing…" : "Remove"}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 px-4 py-3">
        {p?.workflowFileName || p?.workflowName ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-medium text-fg">
              {p.workflowFileName ?? p.workflowName}
            </span>
            {p.workflowName && p.workflowFileName && (
              <span className="text-[11px] text-fg-subtle">{p.workflowName}</span>
            )}
          </div>
        ) : null}
        {p && p.events.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="eyebrow mr-0.5">On</span>
            {p.events.map((e) => (
              <Badge key={e} variant="outline">
                {e}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-muted">
          <span className="eyebrow mr-0.5">Branches</span>
          {p && p.branches.length > 0 ? (
            p.branches.map((b) => (
              <span key={b} className="inline-flex items-center gap-1 font-mono text-[11px]">
                <GitBranch size={11} className="text-fg-subtle" />
                {b}
              </span>
            ))
          ) : (
            <span className="text-[12px] text-fg-subtle">all branches</span>
          )}
        </div>
        {p && p.runsOn.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-muted">
            <span className="eyebrow mr-0.5">Runs on</span>
            {p.runsOn.map((l) => (
              <code key={l} className="font-mono text-[11px] text-fg">
                {l}
              </code>
            ))}
          </div>
        )}
        <p className="text-[12px] text-fg-subtle">
          First run absorbs this placeholder:{" "}
          <code className="font-mono text-fg">
            ndh dispatch --server {hubUrl} --repository {project.name}
          </code>
        </p>
      </div>
    </Card>
  );
}

function RemoveDialog({
  project,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  project: EnrichedProject;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card
        role="dialog"
        aria-modal="true"
        aria-label={`Remove project ${project.name}`}
        className="w-full max-w-md p-5"
      >
        <h2 className="text-base font-semibold text-fg">Remove {project.name}?</h2>
        <p className="mt-2 text-[13px] text-fg-muted">
          This permanently deletes all{" "}
          <span className="font-semibold text-fg">{project.runCount}</span>{" "}
          {project.runCount === 1 ? "run" : "runs"} for{" "}
          <span className="font-mono text-fg">{project.name}</span> and their persisted job logs.
          A project is derived from its runs, so once no runs reference it, it disappears from this
          list. This cannot be undone.
        </p>

        {error && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-fail/10 px-3 py-2 text-[12px] text-fail">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-fail text-white hover:brightness-110"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Removing…" : "Delete runs"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="flex flex-col gap-4">
      {[0, 1].map((i) => (
        <Card key={i} className="p-4">
          <div className="mb-3 h-5 w-48 animate-pulse rounded bg-raised" />
          <div className="h-4 w-full animate-pulse rounded bg-raised" />
        </Card>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="px-6 py-16 text-center">
      <p className="text-sm font-medium text-fg">No projects yet</p>
      <p className="mt-1.5 text-[13px] text-fg-muted">
        Projects appear here once this hub has run one. Dispatch from a checkout:
      </p>
      <code className="mt-2 inline-block rounded-md bg-raised px-2.5 py-1 font-mono text-[12px] text-fg">
        ndh dispatch --server &lt;hub&gt;
      </code>
    </Card>
  );
}

function ErrorState() {
  return (
    <Card className="px-6 py-16 text-center">
      <span className="inline-flex items-center gap-2 text-sm text-fail">
        <TriangleAlert size={16} />
        Couldn&apos;t reach the hub. Retrying…
      </span>
    </Card>
  );
}


/** "N/M" chip: how many of the project's workflows are green on their latest run (#per-YAML). */
function WorkflowChip({ workflows }: { workflows: EnrichedWorkflow[] }) {
  const { passing, total, tone } = summarizeWorkflows(workflows);
  if (total === 0) return null;
  const toneClass =
    tone === "green"
      ? "bg-success/10 text-success"
      : tone === "red"
        ? "bg-fail/10 text-fail"
        : "bg-warn/10 text-warn";
  return (
    <span
      className={`tnum inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${toneClass}`}
      title={`${passing} of ${total} workflows passing on their latest run`}
    >
      {passing}/{total}
    </span>
  );
}
