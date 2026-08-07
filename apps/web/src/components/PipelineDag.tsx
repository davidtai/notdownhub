import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Job, JobGraph } from "../lib/api";
import { toState, matrixLabel } from "../lib/format";
import { useMediaQuery } from "../lib/hooks";
import { StatusIcon } from "./StatusIcon";
import { cn } from "../lib/utils";

interface Edge {
  path: string;
}

/**
 * GitHub-style pipeline: jobs laid left-to-right in columns by dependency depth,
 * with SVG connectors drawn from real `needs` edges (parsed from the workflow YAML).
 * Matrix expansions stack within their identifier's column; the matrix "parent"
 * placeholder the API returns (matrix === null with expanded siblings) is hidden.
 */
export function PipelineDag({
  jobs,
  graph,
  selectedJobId,
  onSelect,
}: {
  jobs: Job[];
  graph: JobGraph;
  selectedJobId: string | null;
  onSelect: (job: Job) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  // On phones the dependency levels stack top-to-bottom; edges flow downward.
  const vertical = useMediaQuery("(max-width: 640px)");

  // Hide the matrix parent placeholder (same identifier, but a real expansion exists).
  const visible = useMemo(() => {
    const expanded = new Set(jobs.filter((j) => j.matrix !== null).map((j) => j.workflowIdentifier));
    return jobs.filter((j) => !(j.matrix === null && expanded.has(j.workflowIdentifier)));
  }, [jobs]);

  const columns = useMemo(() => {
    const byDepth = new Map<number, Job[]>();
    for (const j of visible) {
      const d = graph.depth[j.workflowIdentifier] ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(j);
    }
    return [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
  }, [visible, graph]);

  // Measure node boxes and draw connectors between dependent jobs.
  useLayoutEffect(() => {
    const compute = () => {
      const container = containerRef.current;
      if (!container) return;
      const base = container.getBoundingClientRect();
      setDims({ w: base.width, h: base.height });
      const rectOf = (id: string) => {
        const el = nodeRefs.current.get(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          top: r.top - base.top,
          bottom: r.bottom - base.top,
          left: r.left - base.left,
          right: r.right - base.left,
          midX: r.left - base.left + r.width / 2,
          midY: r.top - base.top + r.height / 2,
        };
      };

      const next: Edge[] = [];
      const byIdentifier = new Map<string, Job[]>();
      for (const j of visible) {
        if (!byIdentifier.has(j.workflowIdentifier)) byIdentifier.set(j.workflowIdentifier, []);
        byIdentifier.get(j.workflowIdentifier)!.push(j);
      }
      for (const target of visible) {
        for (const needKey of graph.needs[target.workflowIdentifier] ?? []) {
          for (const source of byIdentifier.get(needKey) ?? []) {
            const a = rectOf(source.jobId);
            const b = rectOf(target.jobId);
            if (!a || !b) continue;
            if (vertical) {
              // top-to-bottom: source bottom-center → target top-center
              const x1 = a.midX, y1 = a.bottom, x2 = b.midX, y2 = b.top;
              const dy = Math.max(16, (y2 - y1) / 2);
              next.push({ path: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}` });
            } else {
              // left-to-right: source right-center → target left-center
              const x1 = a.right, y1 = a.midY, x2 = b.left, y2 = b.midY;
              const dx = Math.max(24, (x2 - x1) / 2);
              next.push({ path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}` });
            }
          }
        }
      }
      setEdges(next);
    };

    compute();
    const ro = new ResizeObserver(compute);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("resize", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
    };
  }, [visible, graph, vertical]);

  return (
    <div className={cn(vertical ? "overflow-visible" : "overflow-x-auto")}>
      <div
        ref={containerRef}
        className={cn(
          "relative p-1",
          vertical ? "flex flex-col items-stretch gap-9" : "inline-flex min-w-full gap-14",
        )}
      >
        {/* connectors sit under the cards */}
        <svg
          className="pointer-events-none absolute inset-0"
          width={dims.w}
          height={dims.h}
          fill="none"
        >
          {edges.map((e, i) => (
            <path key={i} d={e.path} stroke="var(--edge)" strokeWidth={1.75} opacity={0.7} />
          ))}
        </svg>

        {columns.map((col, ci) => (
          <div
            key={ci}
            className={cn(
              "relative z-10 flex justify-center gap-4",
              vertical ? "flex-row flex-wrap" : "min-w-[200px] flex-col",
            )}
          >
            {col.map((job) => {
              const state = toState(job.status, job.result);
              const mLabel = matrixLabel(job.matrix);
              const selected = job.jobId === selectedJobId;
              return (
                <button
                  key={job.jobId}
                  ref={(el) => {
                    if (el) nodeRefs.current.set(job.jobId, el);
                    else nodeRefs.current.delete(job.jobId);
                  }}
                  onClick={() => onSelect(job)}
                  aria-pressed={selected}
                  className={cn(
                    "flex w-[200px] items-center gap-2.5 rounded-[var(--radius-card)] border bg-surface px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "border-brand ring-1 ring-brand"
                      : "border-line hover:border-line-strong hover:bg-surface-2",
                  )}
                >
                  <StatusIcon state={state} size={16} withTooltip={false} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[13px] font-semibold text-fg">
                      {job.workflowIdentifier}
                    </span>
                    {mLabel && (
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-fg-muted">
                        {mLabel}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
