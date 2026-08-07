import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, GitBranch, GitCommitHorizontal } from "lucide-react";
import { getRuns, getAttempts, getJobs, getTimeline, getArtifacts, getRunsMeta, type Job, type TimelineRecord, type WorkflowRun } from "../lib/api";
import { toState, shortRef, shortSha, elapsedMs, timelineSpan, projectLabel, isFinished, relativeTime, absoluteTime, humanDuration } from "../lib/format";
import { countAnnotations } from "../lib/warnings";
import { usePoll } from "../lib/hooks";
import { AppBar } from "../components/AppBar";
import { Artifacts } from "../components/Artifacts";
import { JobList } from "../components/JobList";
import { JobLog } from "../components/JobLog";
import { RunActions } from "../components/RunActions";
import { RerunButton } from "../components/RerunButton";
import { StatusIcon, StatePill } from "../components/StatusIcon";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const runId = Number(id);
  const navigate = useNavigate();

  const runsList = usePoll(() => getRuns(0), 5000);
  const attempts = usePoll(() => getAttempts(runId), 3000, [runId]);

  // Real execution timing from the hub DB (issue #96): started/finished/duration.
  // One-id batch on the same endpoint the runs list uses; polled so a running
  // run's "running for …" and eventual finish time stay live.
  const metaPoll = usePoll(() => getRunsMeta([runId]), 3000, [runId]);
  const runMeta = metaPoll.data?.[runId];

  const summary = useMemo(() => (runsList.data ?? []).find((r) => r.id === runId), [runsList.data, runId]);

  // A deleted run is filtered from the list and its detail 404s (getAttempts throws). Distinguish
  // that from "still loading" so we can show a clear tombstone instead of an empty, stuck page.
  const notFound = !runsList.initial && !summary && !attempts.initial && attempts.error !== null;

  const attemptList = attempts.data ?? [];
  // null = follow the newest attempt. A re-run adds an attempt on the next poll; following means
  // the view advances to it with no reload. Clicking an OLDER attempt pins the view to it;
  // clicking the newest returns to following (so the next re-run advances again).
  const [pinnedAttempt, setPinnedAttempt] = useState<number | null>(null);
  useEffect(() => setPinnedAttempt(null), [runId]);
  const maxAttempt = attemptList.length > 0 ? Math.max(...attemptList.map((a) => a.attempt)) : null;
  const attempt = attemptList.find((a) => a.attempt === (pinnedAttempt ?? maxAttempt)) ?? attemptList[0];
  const activeAttempt = attempt?.attempt ?? 1;

  const jobs = usePoll(() => getJobs(runId, activeAttempt), 3000, [runId, activeAttempt]);
  const jobList = useMemo(() => jobs.data ?? [], [jobs.data]);

  // A run's uploaded artifacts. Polled slowly — they only appear once a job finishes uploading.
  const artifacts = usePoll(() => getArtifacts(runId), 5000, [runId]);
  const artifactList = artifacts.data ?? [];

  // Fetch every job's timeline together: powers per-job durations and the selected job's steps.
  const timelineKey = jobList.map((j) => j.timeLineId).join(",");
  const timelines = usePoll(
    async () => {
      const entries = await Promise.all(
        jobList.map(async (j) => [j.timeLineId, await getTimeline(j.timeLineId).catch(() => [])] as const),
      );
      return Object.fromEntries(entries) as Record<string, TimelineRecord[]>;
    },
    3000,
    [timelineKey],
  );
  const byTimeline = timelines.data ?? {};

  const durations = useMemo(() => {
    const out: Record<string, number> = {};
    for (const j of jobList) {
      const span = timelineSpan(byTimeline[j.timeLineId] ?? []);
      out[j.jobId] = elapsedMs(span.start, span.finish);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobList, timelines.data]);

  // Warning signals per job (from the engine's timeline annotations), and the run total.
  const warningsByJob = useMemo(() => {
    const out: Record<string, number> = {};
    for (const j of jobList) out[j.jobId] = countAnnotations(byTimeline[j.timeLineId] ?? []);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobList, timelines.data]);
  const runWarnings = useMemo(
    () => Object.values(warningsByJob).reduce((a, b) => a + b, 0),
    [warningsByJob],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedJob: Job | undefined = jobList.find((j) => j.jobId === selectedId);
  useEffect(() => {
    if (jobList.length === 0) return;
    if (!selectedId || !jobList.some((j) => j.jobId === selectedId)) {
      const first = jobList.find((j) => j.matrix !== null) ?? jobList[0];
      setSelectedId(first.jobId);
    }
  }, [jobList, selectedId]);

  const headerState = summary
    ? toState(summary.status, summary.result)
    : attempt
      ? toState(attempt.status, attempt.result)
      : "unknown";

  const ref = shortRef(summary?.ref ?? attempt?.ref);
  const sha = shortSha(summary?.sha ?? attempt?.sha);
  const eventName = summary?.eventName ?? attempt?.eventName;
  const project = summary ? projectLabel(summary) : null;
  const title = summary?.displayName || summary?.fileName || `Run ${runId}`;

  // The run object the header actions act on: the list summary when present, else the current
  // attempt's status/result so a run only reachable by deep link still gets the right controls.
  const headerRun: WorkflowRun = summary ?? { id: runId, status: attempt?.status ?? null, result: attempt?.result ?? null };

  if (notFound) {
    return (
      <div className="min-h-full">
        <AppBar />
        <main className="mx-auto max-w-[1160px] px-4 py-6 sm:px-6">
          <Link to="/" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-muted hover:text-fg">
            <ArrowLeft size={14} />
            Runs
          </Link>
          <div className="px-6 py-16 text-center">
            <p className="text-sm font-medium text-fg">Run #{runId} not found</p>
            <p className="mt-1.5 text-[13px] text-fg-muted">It may have been deleted.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-full">
      <AppBar />

      <main className="mx-auto max-w-[1160px] px-4 py-6 sm:px-6">
        <Link to="/" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-muted hover:text-fg">
          <ArrowLeft size={14} />
          Runs
        </Link>

        {/* Run header */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5">
              <StatusIcon state={headerState} size={22} />
            </span>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-semibold text-fg">{title}</h1>
                <span className="tnum font-mono text-sm text-fg-subtle">#{runId}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2.5 text-[12px] text-fg-muted">
                <StatePill state={headerState} warnings={headerState === "success" ? runWarnings : 0} />
                {project && <span className="truncate font-mono text-[11px]">{project}</span>}
                {eventName && <Badge variant="outline">{eventName}</Badge>}
                {ref && (
                  <span className="flex items-center gap-1 font-mono text-[11px]">
                    <GitBranch size={11} className="text-fg-subtle" />
                    {ref}
                  </span>
                )}
                {sha && (
                  <span className="flex items-center gap-1 font-mono text-[11px]">
                    <GitCommitHorizontal size={12} className="text-fg-subtle" />
                    {sha}
                  </span>
                )}
                {/* Real execution times (#96): started + duration, absolute on hover.
                    Shown only when the hub DB recorded them — never fabricated. */}
                {runMeta?.startedAt && (
                  <span className="tnum text-[11px]" title={`Started ${absoluteTime(runMeta.startedAt)}`}>
                    started {relativeTime(runMeta.startedAt)}
                  </span>
                )}
                {runMeta?.startedAt && !runMeta.finishedAt && headerState === "running" && (
                  <span className="tnum text-[11px]">running for {humanDuration(elapsedMs(runMeta.startedAt))}</span>
                )}
                {runMeta?.durationMs !== undefined && (
                  <span
                    className="tnum text-[11px]"
                    title={runMeta.finishedAt ? `Finished ${absoluteTime(runMeta.finishedAt)}` : undefined}
                  >
                    took {humanDuration(runMeta.durationMs)}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-col items-end gap-3">
            {/* Actions row: re-run a finished run alongside cancel/delete (each state-gated). */}
            <div className="flex items-center gap-2">
              {isFinished(headerState) && (
                <RerunButton
                  runId={runId}
                  size="md"
                  onDone={() => {
                    // Surface the new attempt (and the run's flip back to running) at once.
                    attempts.refresh();
                    runsList.refresh();
                  }}
                />
              )}
              <RunActions
                run={headerRun}
                onCancelled={() => {
                  runsList.refresh();
                  attempts.refresh();
                }}
                onDeleted={() => navigate("/")}
              />
            </div>

            {attemptList.length > 1 && (
              <div className="flex items-center gap-1.5">
                <span className="eyebrow">Attempt</span>
                {attemptList
                  .slice()
                  .sort((a, b) => a.attempt - b.attempt)
                  .map((a) => (
                    <button
                      key={a.attempt}
                      onClick={() => setPinnedAttempt(a.attempt === maxAttempt ? null : a.attempt)}
                      className={cn(
                        "h-11 w-11 rounded-md font-mono text-xs sm:h-8 sm:w-8",
                        a.attempt === activeAttempt
                          ? "bg-accent text-white"
                          : "border border-line text-fg-muted hover:text-fg",
                      )}
                    >
                      {a.attempt}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* Jobs + steps/logs */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr]">
          <Card className="h-max overflow-hidden">
            <div className="border-b border-line px-3 py-2">
              <span className="eyebrow">Jobs</span>
            </div>
            {jobs.initial ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-9 animate-pulse rounded-md bg-raised" />
                ))}
              </div>
            ) : jobList.length === 0 ? (
              <p className="px-3 py-10 text-center text-[12px] text-fg-muted">No jobs for this attempt yet.</p>
            ) : (
              <JobList jobs={jobList} durations={durations} warnings={warningsByJob} selectedJobId={selectedId} onSelect={(j) => setSelectedId(j.jobId)} />
            )}
          </Card>

          <Card className="h-[560px] overflow-hidden">
            <JobLog
              runId={runId}
              job={selectedJob}
              records={selectedJob ? (byTimeline[selectedJob.timeLineId] ?? null) : null}
              loading={timelines.initial}
            />
          </Card>
        </div>

        <Artifacts runId={runId} artifacts={artifactList} />
      </main>
    </div>
  );
}
