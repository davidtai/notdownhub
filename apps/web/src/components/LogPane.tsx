import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, Terminal } from "lucide-react";
import { cn } from "../lib/utils";

const MAX_LINES = 5000;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b?\[[0-9;]*m/g;

interface LogEvent {
  record?: { value?: string[]; stepId?: string };
}

const strip = (l: string) => l.replace(ANSI, "");

/**
 * Live console for a job. The hub's log SSE is the *query-param* form
 * (GET /_apis/v1/TimeLineWebConsoleLog?timelineId=<jobTimelineId>) — the path
 * form /{timelineId} is a one-shot historical snapshot, not a stream. We seed
 * from that snapshot (so a job selected mid-run shows what it already printed),
 * then append live `log` events. Auto-scrolls while pinned; unpins on scroll-up.
 */
export function LogPane({ timelineId, jobDone }: { timelineId: string | null; jobDone: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  useEffect(() => {
    setLines([]);
    setConnected(false);
    if (!timelineId) return;
    let aborted = false;

    // Seed with whatever the hub still holds for this timeline (may be empty —
    // console logs are ephemeral and are dropped once a job is fully done).
    fetch(`/_apis/v1/TimeLineWebConsoleLog/${timelineId}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((dict: Record<string, Array<{ line?: string; lineNumber?: number } | string>>) => {
        if (aborted || !dict || typeof dict !== "object") return;
        const seeded: { n: number; line: string }[] = [];
        for (const records of Object.values(dict)) {
          if (!Array.isArray(records)) continue;
          for (const rec of records) {
            if (typeof rec === "string") seeded.push({ n: seeded.length, line: strip(rec) });
            else seeded.push({ n: rec.lineNumber ?? seeded.length, line: strip(rec.line ?? "") });
          }
        }
        seeded.sort((a, b) => a.n - b.n);
        if (seeded.length) setLines(seeded.map((s) => s.line));
      })
      .catch(() => {});

    const es = new EventSource(`/_apis/v1/TimeLineWebConsoleLog?timelineId=${timelineId}`);
    es.onopen = () => !aborted && setConnected(true);
    es.onerror = () => !aborted && setConnected(false);
    const onLog = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as LogEvent;
        const incoming = data.record?.value;
        if (!incoming?.length) return;
        setLines((prev) => {
          const next = prev.concat(incoming.map(strip));
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      } catch {
        /* ignore malformed frames */
      }
    };
    es.addEventListener("log", onLog as EventListener);
    return () => {
      aborted = true;
      es.removeEventListener("log", onLog as EventListener);
      es.close();
    };
  }, [timelineId]);

  useLayoutEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== pinnedRef.current) setPinned(atBottom);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-3 py-2">
        <span className="flex items-center gap-2">
          <Terminal size={14} className="text-brand" />
          <span className="eyebrow">Live log</span>
          <span className={cn("font-mono text-[11px]", connected ? "text-st-success" : "text-fg-faint")}>
            {connected ? "● streaming" : "○ idle"}
          </span>
        </span>
        <button
          onClick={() => {
            setPinned(true);
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }}
          className={cn(
            "inline-flex min-h-[44px] items-center gap-1.5 rounded px-2.5 font-mono text-[12px] transition-colors",
            pinned ? "bg-surface-2 text-brand" : "text-fg-muted hover:text-fg",
          )}
          title="Pin to bottom"
          aria-pressed={pinned}
        >
          <ArrowDownToLine size={13} />
          {pinned ? "Pinned" : "Pin to bottom"}
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto [-webkit-overflow-scrolling:touch] bg-[color-mix(in_srgb,var(--surface)_55%,var(--bg))] px-3 py-2 font-mono text-[12.5px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="py-8 text-center text-[11px] text-fg-muted">
            {jobDone
              ? "This job has finished. Live output streams here while a job is running."
              : "Waiting for output…"}
          </p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="flex gap-3 whitespace-pre-wrap break-all">
              <span className="w-9 shrink-0 select-none text-right text-fg-faint">{i + 1}</span>
              <span className="text-fg">{line || " "}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
