import { describe, it, expect } from "vitest";
import { stripAnsi, parseLogGroups, countLines, type LogNode } from "./logparse";

describe("stripAnsi", () => {
  it("removes SGR color codes and leaves plain text", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("[32mgreen[0m")).toBe("green"); // bare CSI form
    expect(stripAnsi("plain")).toBe("plain");
  });
});

describe("parseLogGroups", () => {
  it("keeps flat lines at the root", () => {
    const tree = parseLogGroups(["a", "b"]);
    expect(tree).toEqual([
      { kind: "line", text: "a" },
      { kind: "line", text: "b" },
    ]);
  });

  it("folds a group with its title and children", () => {
    const tree = parseLogGroups(["##[group]Build", "step", "##[endgroup]", "after"]);
    expect(tree[0]).toMatchObject({ kind: "group", title: "Build" });
    const grp = tree[0] as Extract<LogNode, { kind: "group" }>;
    expect(grp.children).toEqual([{ kind: "line", text: "step" }]);
    expect(tree[1]).toEqual({ kind: "line", text: "after" });
  });

  it("nests groups and defaults an empty title", () => {
    const tree = parseLogGroups(["##[group]", "##[group]Inner", "x", "##[endgroup]", "##[endgroup]"]);
    const outer = tree[0] as Extract<LogNode, { kind: "group" }>;
    expect(outer.title).toBe("Group");
    const inner = outer.children[0] as Extract<LogNode, { kind: "group" }>;
    expect(inner.title).toBe("Inner");
    expect(inner.children).toEqual([{ kind: "line", text: "x" }]);
  });

  it("lets an unclosed group run to the end", () => {
    const tree = parseLogGroups(["##[group]Open", "a", "b"]);
    const grp = tree[0] as Extract<LogNode, { kind: "group" }>;
    expect(grp.children).toHaveLength(2);
  });

  it("ignores a stray endgroup", () => {
    const tree = parseLogGroups(["##[endgroup]", "a"]);
    expect(tree).toEqual([{ kind: "line", text: "a" }]);
  });

  it("strips ANSI on the way in", () => {
    const tree = parseLogGroups(["\x1b[31mred line"]);
    expect(tree).toEqual([{ kind: "line", text: "red line" }]);
  });
});

describe("countLines", () => {
  it("counts leaves across nested groups", () => {
    const tree = parseLogGroups(["a", "##[group]G", "b", "##[group]H", "c", "##[endgroup]", "##[endgroup]"]);
    expect(countLines(tree)).toBe(3);
  });

  it("is zero for an empty tree", () => {
    expect(countLines([])).toBe(0);
  });
});
