/*
  Console log helpers. Two jobs:
   1. Strip ANSI SGR color codes so lines render as plain text.
   2. Parse the runner's `##[group]Title` / `##[endgroup]` markers into a nested
      tree, so the log view can fold sections the way GitHub's checks UI does.
*/

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b?\[[0-9;]*m/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI, "");
}

const GROUP = /##\[group\](.*)$/;
const ENDGROUP = /##\[endgroup\]/;

export type LogNode =
  | { kind: "line"; text: string }
  /** `closed` is true once a matching `##[endgroup]` was seen — i.e. the group has finished
   *  (vs. one still streaming). The view uses it to collapse completed groups, GitHub-style. */
  | { kind: "group"; title: string; children: LogNode[]; closed: boolean };

/**
 * Fold a flat list of console lines into a tree of lines and (possibly nested)
 * groups. Unbalanced markers degrade gracefully — an unclosed group simply runs
 * to the end (and stays `closed: false`), and a stray endgroup is ignored.
 */
export function parseLogGroups(lines: string[]): LogNode[] {
  const root: LogNode[] = [];
  const stack: Extract<LogNode, { kind: "group" }>[] = [];
  const current = () => (stack.length ? stack[stack.length - 1].children : root);

  for (const raw of lines) {
    const line = stripAnsi(raw);
    const g = line.match(GROUP);
    if (g) {
      const node = { kind: "group" as const, title: g[1].trim() || "Group", children: [], closed: false };
      current().push(node);
      stack.push(node);
      continue;
    }
    if (ENDGROUP.test(line)) {
      const top = stack.pop();
      if (top) top.closed = true;
      continue;
    }
    current().push({ kind: "line", text: line });
  }
  return root;
}

/** Count the leaf log lines in a tree (for a group's line-count hint). */
export function countLines(nodes: LogNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === "line") n += 1;
    else n += countLines(node.children);
  }
  return n;
}
