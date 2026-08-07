import { describe, it, expect } from "vitest";
import {
  ALL,
  GLOBAL,
  compareScopes,
  distinctScopes,
  filterByScope,
  groupByScope,
  isRepoSlug,
  projectScopeOptions,
} from "./scopes";

type Row = { scope: string; name: string };
const rows: Row[] = [
  { scope: "acme/web", name: "B" },
  { scope: GLOBAL, name: "A" },
  { scope: "acme/api", name: "C" },
  { scope: GLOBAL, name: "D" },
  { scope: "acme/web", name: "E" },
];

describe("compareScopes", () => {
  it("orders global first, then alphabetical, and is stable on equality", () => {
    expect(compareScopes(GLOBAL, "acme/x")).toBeLessThan(0);
    expect(compareScopes("acme/x", GLOBAL)).toBeGreaterThan(0);
    expect(compareScopes("acme/a", "acme/b")).toBeLessThan(0);
    expect(compareScopes("acme/x", "acme/x")).toBe(0);
  });
});

describe("distinctScopes", () => {
  it("returns each scope once, global-first then alphabetical", () => {
    expect(distinctScopes(rows)).toEqual([GLOBAL, "acme/api", "acme/web"]);
  });
  it("is empty for no rows", () => {
    expect(distinctScopes([])).toEqual([]);
  });
});

describe("groupByScope", () => {
  it("groups rows under their scope in display order, preserving row order within a group", () => {
    const groups = groupByScope(rows);
    expect(groups.map((g) => g.scope)).toEqual([GLOBAL, "acme/api", "acme/web"]);
    expect(groups[0].items.map((r) => r.name)).toEqual(["A", "D"]);
    expect(groups[2].items.map((r) => r.name)).toEqual(["B", "E"]);
  });
});

describe("filterByScope", () => {
  it("keeps everything for the ALL sentinel", () => {
    expect(filterByScope(rows, ALL)).toHaveLength(5);
  });
  it("narrows to a single scope", () => {
    expect(filterByScope(rows, "acme/web").map((r) => r.name)).toEqual(["B", "E"]);
  });
  it("returns [] for a scope not present", () => {
    expect(filterByScope(rows, "nobody/none")).toEqual([]);
  });
});

describe("projectScopeOptions", () => {
  it("returns null-safe [] and only owner/name slugs, deduped and sorted", () => {
    expect(projectScopeOptions(null)).toEqual([]);
    expect(
      projectScopeOptions([
        { name: "acme/web" },
        { name: "acme/api" },
        { name: "local/checkout" }, // a real repo slug — retained
        { name: "Unknown/Unknown" },
        { name: "just-a-name" }, // no slash → excluded
        { name: "acme/web" }, // duplicate → collapsed
      ]),
    ).toEqual(["acme/api", "acme/web", "local/checkout", "Unknown/Unknown"]);
  });
});

describe("isRepoSlug", () => {
  it("accepts owner/name and rejects malformed values", () => {
    expect(isRepoSlug("acme/x")).toBe(true);
    expect(isRepoSlug("nope")).toBe(false);
    expect(isRepoSlug("a/b/c")).toBe(false);
    expect(isRepoSlug("a /b")).toBe(false);
    expect(isRepoSlug("")).toBe(false);
  });
});
