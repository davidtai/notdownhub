import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChevronRight, Radio, TriangleAlert } from "lucide-react";
import { getJobLogs, type Job, type JobLogs, type TimelineRecord } from "../lib/api";
import { toState, duration } from "../lib/format";
import { stripAnsi } from "../lib/logparse";
import { collectAnnotations, countAnnotations, type Annotation } from "../lib/warnings";
import { StatusIcon, WarningMarker } from "./StatusIcon";
import { LogGroups } from "./LogView";
import { cn } from "../lib/utils";

const MAX_LINES = 5000;
const FALLBACK_KEY = "__job__";

type Historical = "idle" | "loading" | JobLogs;

/**
 * The run-detail right pane: the selected job's steps as collapsible log groups.
 *
 * While the job is active we stream its console over SSE (query-param form) and
 * route each frame's lines to its step by `stepId` (falling back to the running
 * or last step). Once the job is done and the live source is empty, we read the
 * persisted job-level log from /api/local/joblogs and render it with the same
 * `##[group]` folding. If nothing was retained, we say so rather than show blank.
 */
export function JobLog({
  runId,
  job,
  records,
  loading,
  displayName,
}: {
  runId: number;
  job: Job | undefined;
  records: TimelineRecord[] | null;
  loading: boolean;
  /** #114 alias for the selected job, when one is set — the original stays in the title tooltip. */
  displayName?: string | null;
}) {
  const steps = useMemo(
    () =>
      (records ?? [])
        .filter((r) => r.type?.toLowerCase() === "task")
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [records],
  );

  const jobState = job ? toState(job.status, job.result) : "unknown";
  const jobActive = jobState === "running" || jobState === "queued";

  // Engine annotations for this job (warnings + non-fatal errors), shown above the
  // log GitHub-style. Steps that raised one also get an inline marker.
  const annotations = useMemo(() => collectAnnotations(records ?? []), [records]);

  const [liveByStep, setLiveByStep] = useState<Record<string, string[]>>({});
  const [connected, setConnected] = useState(false);
  const [historical, setHistorical] = useState<Historical>("idle");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pinned, setPinned] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const hasLive = useMemo(
    () => Object.values(liveByStep).some((v) => v.length > 0),
    [liveByStep],
  );

  // Reset all per-job state when the selected job changes.
  useEffect(() => {
    setLiveByStep({});
    setConnected(false);
    setHistorical("idle");
    setExpanded(new Set());
    setPinned(true);
  }, [job?.timeLineId]);

  // Live console stream while the job is active.
  useEffect(() => {
    if (!job || !jobActive) return;
    const es = new EventSource(`/_apis/v1/TimeLineWebConsoleLog?timelineId=${job.timeLineId}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const onLog = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { timelineId?: string; record?: { value?: string[]; stepId?: string } };
        // The hub multiplexes every job's console onto one feed; keep only this job's timeline
        // (the `?timelineId=` query param is advisory — the hub does not filter server-side).
        if (data.timelineId && data.timelineId !== job.timeLineId) return;
        const value = data.record?.value;
        if (!value?.length) return;
        const cur = stepsRef.current;
        const ids = new Set(cur.map((s) => s.id));
        let sid = data.record?.stepId && ids.has(data.record.stepId) ? data.record.stepId : "";
        if (!sid) {
          const running = [...cur].reverse().find((s) => toState(s.state, s.result) === "running");
          sid = (running ?? cur[cur.length - 1])?.id ?? FALLBACK_KEY;
        }
        setLiveByStep((prev) => {
          const merged = (prev[sid] ?? []).concat(value.map(stripAnsi));
          const capped = merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
          return { ...prev, [sid]: capped };
        });
      } catch {
        /* ignore malformed frames */
      }
    };
    es.addEventListener("log", onLog as EventListener);
    return () => {
      es.removeEventListener("log", onLog as EventListener);
      es.close();
    };
  }, [job?.timeLineId, jobActive]);

  // Once the job is finished, load the persisted (complete) console from the hub DB and show it.
  // The live buffer is ephemeral and lossy — lines can arrive attributed to the job record before
  // steps load, or flush right as the job ends and the stream closes — so a watched-to-completion
  // job must fall back to the retained log instead of whatever the live stream happened to capture.
  useEffect(() => {
    if (!job || jobActive) return;
    let alive = true;
    setHistorical("loading");
    getJobLogs(runId, job.timeLineId).then((r) => {
      if (alive) setHistorical(r);
    });
    return () => {
      alive = false;
    };
  }, [job?.timeLineId, jobActive, runId]);

  // Auto-expand the running step so its output is visible without a click.
  useEffect(() => {
    const running = steps.find((s) => toState(s.state, s.result) === "running");
    if (running) {
      setExpanded((prev) => (prev.has(running.id) ? prev : new Set(prev).add(running.id)));
    }
  }, [steps]);

  const stickToBottom = () => {
    const el = scrollRef.current;
    if (pinnedRef.current && el) el.scrollTop = el.scrollHeight;
  };

  // Immediate stick on the common content updates (new lines, a step folding).
  useLayoutEffect(stickToBottom, [liveByStep, expanded]);

  // Robust auto-scroll: a ResizeObserver re-sticks on ANY content-height change — not only the
  // few state updates a dependency array can name. Previously a growth the deps didn't cover
  // (step rows re-rendering, the job finishing, the retained log loading) left the view stranded
  // mid-log while the control still read "Pinned". Observing the content element catches them all.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => stickToBottom());
    ro.observe(content);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    if (atBottom !== pinnedRef.current) setPinned(atBottom);
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Stream while the job is active; a finished job renders the retained (complete) log instead.
  const liveMode = jobActive;
  const retained = typeof historical === "object" ? historical : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="flex min-w-0 items-center gap-2">
          {job && <StatusIcon state={jobState} size={14} withTooltip={false} />}
          <span
            className="truncate text-[13px] font-medium text-fg"
            title={displayName && job ? `Original: ${job.name}` : undefined}
          >
            {displayName ?? job?.name ?? "Select a job"}
          </span>
        </span>
        {liveMode && (
          <span className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1 text-[11px]",
                connected ? "text-running" : "text-fg-subtle",
              )}
            >
              <Radio size={12} className={connected ? "spin" : ""} />
              {connected ? "Streaming" : "Idle"}
            </span>
            <button
              onClick={() => {
                const next = !pinned;
                setPinned(next);
                if (next && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }}
              aria-pressed={pinned}
              title={pinned ? "Following new output — click to unpin" : "Pin to bottom and follow output"}
              className={cn(
                "inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-[12px] transition-colors",
                pinned ? "bg-raised text-accent" : "text-fg-muted hover:text-fg",
              )}
            >
              <ArrowDownToLine size={13} />
              <span className="hidden sm:inline">{pinned ? "Pinned" : "Pin"}</span>
            </button>
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto [-webkit-overflow-scrolling:touch]"
      >
        <div ref={contentRef}>
        {annotations.length > 0 && <Annotations items={annotations} />}
        {loading && !records && !hasLive ? (
          <StepSkeleton />
        ) : !job ? (
          <Note>Select a job to see its steps.</Note>
        ) : steps.length === 0 && !retained?.lines.length ? (
          liveByStep[FALLBACK_KEY]?.length ? (
            <LogGroups lines={liveByStep[FALLBACK_KEY]} />
          ) : jobActive ? (
            <Note>Waiting for the runner to start this job.</Note>
          ) : retained && !retained.retained ? (
            <Note>Console output was not retained for this run.</Note>
          ) : historical === "loading" ? (
            <Note>Loading logs…</Note>
          ) : (
            <Note>No steps recorded for this job.</Note>
          )
        ) : (
          <>
            <ul className="divide-y divide-line-muted">
              {steps.map((s) => {
                const st = toState(s.state, s.result);
                const d = duration(s.startTime, s.finishTime);
                const sw = st === "success" ? countAnnotations([s]) : 0;
                if (liveMode) {
                  const lines = liveByStep[s.id] ?? [];
                  const open = expanded.has(s.id);
                  const running = st === "running";
                  return (
                    <li key={s.id}>
                      <button
                        onClick={() => toggle(s.id)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-raised"
                      >
                        <ChevronRight
                          size={14}
                          className={cn(
                            "shrink-0 text-fg-subtle transition-transform",
                            open && "rotate-90",
                          )}
                        />
                        <StatusIcon state={st} size={14} withTooltip={false} />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{s.name}</span>
                        {sw > 0 && <WarningMarker count={sw} size={13} />}
                        {d && (
                          <span className="tnum shrink-0 font-mono text-[11px] text-fg-subtle">{d}</span>
                        )}
                      </button>
                      <div className="fold" data-open={open}>
                        <div className="fold-inner">
                          {lines.length > 0 ? (
                            <LogGroups lines={lines} />
                          ) : (
                            <p className="px-3 pb-3 pl-9 font-mono text-[11px] text-fg-subtle">
                              {running ? "Waiting for output…" : "No output captured for this step."}
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                }
                // Historical / summary mode: step rows are read-only.
                return (
                  <li key={s.id} className="flex items-center gap-2.5 px-3 py-2.5">
                    <StatusIcon state={st} size={14} withTooltip={false} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{s.name}</span>
                    {sw > 0 && <WarningMarker count={sw} size={13} />}
                    {d && (
                      <span className="tnum shrink-0 font-mono text-[11px] text-fg-subtle">{d}</span>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* Live lines the hub attributed to the job (not a specific step) — e.g. a burst
                flushed before the step records loaded. Shown so they are never orphaned. */}
            {liveMode && liveByStep[FALLBACK_KEY]?.length ? (
              <section className="border-t border-line">
                <p className="eyebrow px-3 pb-1 pt-2.5">Job output</p>
                <LogGroups lines={liveByStep[FALLBACK_KEY]} />
              </section>
            ) : null}

            {!liveMode &&
              (historical === "loading" ? (
                <Note>Loading logs…</Note>
              ) : retained?.retained && retained.lines.length > 0 ? (
                <section className="border-t border-line">
                  <p className="eyebrow px-3 pb-1 pt-2.5">Job log</p>
                  <LogGroups lines={retained.lines} />
                </section>
              ) : retained ? (
                <Note>Console output was not retained for this run.</Note>
              ) : null)}
          </>
        )}
        </div>
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-10 text-center text-[12px] text-fg-muted">{children}</p>;
}

/**
 * GitHub-parity annotation banner: the engine's warning/non-fatal-error issues for
 * this job, listed above the log so a green-but-noisy job's problems are visible
 * without reading the console. Warnings read amber; non-fatal errors read red.
 */
function Annotations({ items }: { items: Annotation[] }) {
  const warns = items.filter((a) => a.type === "warning").length;
  const errs = items.length - warns;
  const summary = [
    warns > 0 ? `${warns} warning${warns === 1 ? "" : "s"}` : null,
    errs > 0 ? `${errs} error${errs === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="border-b border-line bg-warn/[0.06] px-3 py-2.5" aria-label="Annotations">
      <p className="eyebrow mb-1.5 flex items-center gap-1.5 text-warn">
        <TriangleAlert size={12} />
        Annotations
        <span className="tnum font-mono text-[11px] font-normal text-fg-muted">{summary}</span>
      </p>
      <ul className="space-y-1">
        {items.map((a, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-snug">
            <TriangleAlert
              size={13}
              className={cn("mt-0.5 shrink-0", a.type === "error" ? "text-fail" : "text-warn")}
            />
            <span className="min-w-0">
              <span className="font-medium text-fg">{a.stepName || "Job"}</span>
              <span className="text-fg-subtle"> — </span>
              <span className="break-words text-fg-muted">{a.message}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StepSkeleton() {
  return (
    <ul className="divide-y divide-line-muted">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex items-center gap-2.5 px-3 py-3">
          <div className="h-3.5 w-3.5 animate-pulse rounded-full bg-raised" />
          <div className="h-3.5 flex-1 animate-pulse rounded bg-raised" />
          <div className="h-3 w-9 animate-pulse rounded bg-raised" />
        </li>
      ))}
    </ul>
  );
}
