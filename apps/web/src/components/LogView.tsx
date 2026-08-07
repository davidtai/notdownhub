import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { parseLogGroups, countLines, type LogNode } from "../lib/logparse";
import { cn } from "../lib/utils";

/**
 * Renders console lines with `##[group]` / `##[endgroup]` folded into collapsible
 * sections (nested, GitHub-style). Used for both live per-step output and the
 * historical job-level log.
 */
export function LogGroups({ lines, className }: { lines: string[]; className?: string }) {
  const tree = useMemo(() => parseLogGroups(lines), [lines]);
  if (lines.length === 0) return null;
  return (
    <div className={cn("bg-[color-mix(in_srgb,var(--surface)_60%,var(--canvas))] py-1", className)}>
      <NodeList nodes={tree} depth={0} />
    </div>
  );
}

function NodeList({ nodes, depth }: { nodes: LogNode[]; depth: number }) {
  return (
    <>
      {nodes.map((n, i) =>
        n.kind === "line" ? (
          <LogLine key={i} text={n.text} depth={depth} />
        ) : (
          <Group key={i} node={n} depth={depth} />
        ),
      )}
    </>
  );
}

function LogLine({ text, depth }: { text: string; depth: number }) {
  return (
    <pre
      className="whitespace-pre-wrap break-all pr-3 font-mono text-[12px] leading-[1.55] text-fg"
      style={{ paddingLeft: 12 + depth * 14 }}
    >
      {text || " "}
    </pre>
  );
}

function Group({ node, depth }: { node: Extract<LogNode, { kind: "group" }>; depth: number }) {
  // GitHub Actions parity: a group still streaming (no `##[endgroup]` yet) stays expanded so its
  // live output is visible; a completed group collapses by default. A user click overrides and sticks.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? !node.closed;
  return (
    <div>
      <button
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-1 pr-3 text-left transition-colors hover:bg-raised"
        style={{ paddingLeft: 12 + depth * 14 }}
      >
        <ChevronRight
          size={13}
          className={cn("shrink-0 text-fg-subtle transition-transform", open && "rotate-90")}
        />
        <span className="truncate font-mono text-[12px] font-medium text-fg-muted">
          {node.title}
        </span>
        <span className="tnum ml-auto shrink-0 font-mono text-[11px] text-fg-subtle">
          {countLines(node.children)}
        </span>
      </button>
      <div className="collapse" data-open={open}>
        <div className="collapse-inner">
          <NodeList nodes={node.children} depth={depth + 1} />
        </div>
      </div>
    </div>
  );
}
