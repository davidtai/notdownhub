import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, GitBranch, GitCommitHorizontal, Workflow, Info } from "lucide-react";
import { getRuns, getAttempts, getJobs, getTimeline, buildGraph, type Job } from "../lib/api";
import { toState, shortRef, shortSha, STATE_LABEL } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { Header } from "../components/Header";
import { PipelineDag } from "../components/PipelineDag";
import { StepList } from "../components/StepList";
import { LogPane } from "../components/LogPane";
import { StatusIcon } from "../components/StatusIcon";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { cn } from "../lib/utils";

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const runId = Number(id);

  const runsList = usePoll(() => getRuns(0), 5000);
  const attempts = usePoll(() => getAttempts(runId), 3000, [runId]);

  const summary = useMemo(
    () => (runsList.data ?? []).find((r) => r.id === runId),
    [runsList.data, runId],
  );

  // Attempt selection — default to the latest.
  const attemptList = attempts.data ?? [];
  const [attemptNo, setAttemptNo] = useState<number | null>(null);
  useEffect(() => {
    if (attemptNo === null && attemptList.length > 0) {
      setAttemptNo(Math.max(...attemptList.map((a) => a.attempt)));
    }
  }, [attemptList, attemptNo]);
  const attempt = attemptList.find((a) => a.attempt === attemptNo) ?? attemptList[0];
  const activeAttempt = attempt?.attempt ?? 1;

  const jobs = usePoll(() => getJobs(runId, activeAttempt), 2500, [runId, activeAttempt]);

  const jobList = useMemo(() => jobs.data ?? [], [jobs.data]);
  const graph = useMemo(() => {
    const keys = [...new Set(jobList.map((j) => j.workflowIdentifier))];
    return buildGraph(attempt?.workflow, keys);
  }, [attempt?.workflow, jobList]);

  // Selected job for the steps + log panes.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedJob: Job | undefined = jobList.find((j) => j.jobId === selectedId);
  useEffect(() => {
    if (jobList.length === 0) return;
    if (!selectedId || !jobList.some((j) => j.jobId === selectedId)) {
      // Prefer a real (non matrix-parent) job.
      const first = jobList.find((j) => j.matrix !== null) ?? jobList[0];
      setSelectedId(first.jobId);
    }
  }, [jobList, selectedId]);

  const timeline = usePoll(
    () => (selectedJob ? getTimeline(selectedJob.timeLineId) : Promise.resolve([])),
    2000,
    [selectedJob?.timeLineId],
  );

  const headerState = summary
    ? toState(summary.status, summary.result)
    : attempt
      ? toState(attempt.status, attempt.result)
      : "unknown";
  const isRunning = headerState === "running";

  const ref = shortRef(summary?.ref ?? attempt?.ref);
  const sha = shortSha(summary?.sha ?? attempt?.sha);
  const eventName = summary?.eventName ?? attempt?.eventName;
  const title = summary?.displayName || summary?.fileName || attempt?.eventName || `Run ${runId}`;
  const selectedState = selectedJob ? toState(selectedJob.status, selectedJob.result) : "unknown";

  return (
    <div className="min-h-full">
      <Header liveRuns={isRunning ? 1 : 0} />

      <main className="mx-auto max-w-[1180px] px-5 py-6">
        <Link
          to="/"
          className="mb-4 inline-flex items-center gap-1.5 font-mono text-xs text-fg-muted hover:text-fg"
        >
          <ArrowLeft size={13} />
          runs
        </Link>

        {/* Run header */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <StatusIcon state={headerState} size={22} />
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-bold tracking-tight text-fg">{title}</h1>
                <span className="font-mono text-sm text-fg-faint">#{runId}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5 font-mono text-[11px] text-fg-muted">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5",
                    headerState === "running" && "bg-brand/15 text-brand",
                    headerState === "success" && "bg-st-success/15 text-st-success",
                    headerState === "fail" && "bg-st-fail/15 text-st-fail",
                  )}
                >
                  {STATE_LABEL[headerState]}
                </span>
                {eventName && <Badge variant="outline">{eventName}</Badge>}
                {ref && (
                  <span className="flex items-center gap-1">
                    <GitBranch size={11} className="text-fg-faint" />
                    {ref}
                  </span>
                )}
                {sha && (
                  <span className="flex items-center gap-1">
                    <GitCommitHorizontal size={12} className="text-fg-faint" />
                    {sha}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Attempt selector */}
          {attemptList.length > 1 && (
            <div className="flex items-center gap-1.5">
              <span className="eyebrow">Attempt</span>
              {attemptList
                .slice()
                .sort((a, b) => a.attempt - b.attempt)
                .map((a) => (
                  <button
                    key={a.attempt}
                    onClick={() => setAttemptNo(a.attempt)}
                    className={cn(
                      "h-11 w-11 rounded font-mono text-xs sm:h-8 sm:w-8",
                      a.attempt === activeAttempt
                        ? "bg-brand text-[#0c0f16]"
                        : "border border-line text-fg-muted hover:text-fg",
                    )}
                  >
                    {a.attempt}
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* Pipeline */}
        <section className="mb-6">
          <div className="mb-3 flex items-center gap-2">
            <Workflow size={15} className="text-brand" />
            <span className="eyebrow">Pipeline</span>
            {!graph.derivedFromNeeds && jobList.length > 0 && (
              <span className="flex items-center gap-1 font-mono text-[10px] text-fg-faint">
                <Info size={11} />
                needs edges unavailable — grouped in one stage
              </span>
            )}
          </div>
          <Card className="p-4">
            {jobs.initial ? (
              <div className="flex gap-14">
                {[0, 1].map((i) => (
                  <div key={i} className="h-16 w-[200px] animate-pulse rounded-[var(--radius-card)] bg-surface-2" />
                ))}
              </div>
            ) : jobList.length === 0 ? (
              <p className="py-8 text-center font-mono text-[11px] text-fg-muted">
                No jobs for this attempt yet.
              </p>
            ) : (
              <PipelineDag
                jobs={jobList}
                graph={graph}
                selectedJobId={selectedId}
                onSelect={(j) => setSelectedId(j.jobId)}
              />
            )}
          </Card>
        </section>

        {/* Steps + live log */}
        <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(280px,360px)_1fr]">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="eyebrow">Steps</span>
              {selectedJob && (
                <span className="flex items-center gap-1.5 font-mono text-[11px] text-fg-muted">
                  <StatusIcon state={selectedState} size={12} withTooltip={false} />
                  {selectedJob.name}
                </span>
              )}
            </div>
            <StepList records={timeline.data} loading={timeline.initial} />
          </Card>

          <Card className="h-[460px] overflow-hidden">
            <LogPane
              timelineId={selectedJob?.timeLineId ?? null}
              jobDone={selectedState !== "running" && selectedState !== "queued"}
            />
          </Card>
        </section>
      </main>
    </div>
  );
}
