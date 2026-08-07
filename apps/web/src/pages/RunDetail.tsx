import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, GitBranch, GitCommitHorizontal } from "lucide-react";
import { getRuns, getAttempts, getJobs, getTimeline, type Job, type TimelineRecord } from "../lib/api";
import { toState, shortRef, shortSha, elapsedMs, timelineSpan } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { AppBar } from "../components/AppBar";
import { JobList } from "../components/JobList";
import { JobLog } from "../components/JobLog";
import { StatusIcon, StatePill } from "../components/StatusIcon";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const runId = Number(id);

  const runsList = usePoll(() => getRuns(0), 5000);
  const attempts = usePoll(() => getAttempts(runId), 3000, [runId]);

  const summary = useMemo(() => (runsList.data ?? []).find((r) => r.id === runId), [runsList.data, runId]);

  const attemptList = attempts.data ?? [];
  const [attemptNo, setAttemptNo] = useState<number | null>(null);
  useEffect(() => {
    if (attemptNo === null && attemptList.length > 0) setAttemptNo(Math.max(...attemptList.map((a) => a.attempt)));
  }, [attemptList, attemptNo]);
  const attempt = attemptList.find((a) => a.attempt === attemptNo) ?? attemptList[0];
  const activeAttempt = attempt?.attempt ?? 1;

  const jobs = usePoll(() => getJobs(runId, activeAttempt), 3000, [runId, activeAttempt]);
  const jobList = useMemo(() => jobs.data ?? [], [jobs.data]);

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
  const title = summary?.displayName || summary?.fileName || `Run ${runId}`;

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
                <StatePill state={headerState} />
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
              </div>
            </div>
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
                    onClick={() => setAttemptNo(a.attempt)}
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
              <JobList jobs={jobList} durations={durations} selectedJobId={selectedId} onSelect={(j) => setSelectedId(j.jobId)} />
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
      </main>
    </div>
  );
}
