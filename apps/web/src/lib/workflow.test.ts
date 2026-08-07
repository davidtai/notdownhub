import { describe, it, expect } from "vitest";
import { parseWorkflowTriggers, eventSummary } from "./workflow";

describe("parseWorkflowTriggers", () => {
  it("parses a map form with push branches (list) + workflow_dispatch (null value)", () => {
    const t = parseWorkflowTriggers(
      ["name: CI", "on:", "  push:", "    branches: [main, \"release/*\"]", "  workflow_dispatch:", "jobs: {}"].join(
        "\n",
      ),
    );
    expect(t.empty).toBe(false);
    expect(t.events.map((e) => e.event)).toEqual(["push", "workflow_dispatch"]);
    const push = t.events[0];
    expect(push.branches).toEqual(["main", "release/*"]);
    // workflow_dispatch has no filters.
    expect(t.events[1].branches).toEqual([]);
    // Watched branches = union of include filters.
    expect(t.branches).toEqual(["main", "release/*"]);
  });

  it("accepts a scalar branches filter (string, not list)", () => {
    const t = parseWorkflowTriggers(["on:", "  push:", "    branches: main"].join("\n"));
    expect(t.events[0].branches).toEqual(["main"]);
    expect(t.branches).toEqual(["main"]);
  });

  it("parses the string form: `on: push`", () => {
    const t = parseWorkflowTriggers("on: push\njobs: {}");
    expect(t.empty).toBe(false);
    expect(t.events).toHaveLength(1);
    expect(t.events[0].event).toBe("push");
    expect(t.branches).toEqual([]);
  });

  it("parses the list form: `on: [push, pull_request]`", () => {
    const t = parseWorkflowTriggers("on: [push, pull_request]");
    expect(t.events.map((e) => e.event)).toEqual(["push", "pull_request"]);
  });

  it("filters non-string entries out of the list form", () => {
    const t = parseWorkflowTriggers("on: [push, 5, null]");
    expect(t.events.map((e) => e.event)).toEqual(["push"]);
  });

  it("parses pull_request with branches + types, and unions branches with push", () => {
    const t = parseWorkflowTriggers(
      [
        "on:",
        "  push:",
        "    branches:",
        "      - main",
        "  pull_request:",
        "    branches:",
        "      - main",
        "      - develop",
        "    types: [opened, synchronize]",
      ].join("\n"),
    );
    const pr = t.events.find((e) => e.event === "pull_request")!;
    expect(pr.branches).toEqual(["main", "develop"]);
    expect(pr.types).toEqual(["opened", "synchronize"]);
    // Union across push + pull_request, de-duplicated, order preserved.
    expect(t.branches).toEqual(["main", "develop"]);
  });

  it("captures branches-ignore, tags and paths without counting them as watched branches", () => {
    const t = parseWorkflowTriggers(
      [
        "on:",
        "  push:",
        "    branches-ignore: [wip/**]",
        "    tags: [v*]",
        "    paths:",
        "      - src/**",
      ].join("\n"),
    );
    const push = t.events[0];
    expect(push.branchesIgnore).toEqual(["wip/**"]);
    expect(push.tags).toEqual(["v*"]);
    expect(push.paths).toEqual(["src/**"]);
    // branches-ignore is an exclusion, never surfaced as a watched branch.
    expect(t.branches).toEqual([]);
  });

  it("parses schedule cron as a list of {cron} maps", () => {
    const t = parseWorkflowTriggers(
      ["on:", "  schedule:", '    - cron: "0 0 * * *"', '    - cron: "30 5 * * 1"'].join("\n"),
    );
    const sched = t.events.find((e) => e.event === "schedule")!;
    expect(sched.cron).toEqual(["0 0 * * *", "30 5 * * 1"]);
  });

  it("tolerates schedule given as a single map instead of a list", () => {
    const t = parseWorkflowTriggers(['on:', '  schedule:', '    cron: "0 0 * * *"'].join("\n"));
    expect(t.events[0].cron).toEqual(["0 0 * * *"]);
  });

  it("returns empty for a missing `on:` block", () => {
    const t = parseWorkflowTriggers("name: CI\njobs:\n  build:\n    runs-on: [self-hosted]");
    expect(t).toEqual({ events: [], branches: [], empty: true });
  });

  it("returns empty for an `on:` that is present but has no events (empty map)", () => {
    expect(parseWorkflowTriggers("on: {}").empty).toBe(true);
  });

  it("returns empty for invalid YAML", () => {
    expect(parseWorkflowTriggers("on: [unterminated").empty).toBe(true);
  });

  it("returns empty for a non-object document (bare scalar / empty string)", () => {
    expect(parseWorkflowTriggers("").empty).toBe(true);
    expect(parseWorkflowTriggers("42").empty).toBe(true);
  });

  it("honors the YAML 1.1 `on → true` boolean-coercion fallback", () => {
    // Simulate a document whose `on` key was coerced to the boolean true.
    const t = parseWorkflowTriggers('"true":\n  push:\n    branches: [main]');
    expect(t.empty).toBe(false);
    expect(t.events[0].event).toBe("push");
    expect(t.branches).toEqual(["main"]);
  });

  it("ignores a non-string, non-list, non-map `on` value", () => {
    expect(parseWorkflowTriggers("on: 5").empty).toBe(true);
  });
});

describe("eventSummary", () => {
  const base = { branches: [], branchesIgnore: [], tags: [], paths: [], types: [], cron: [] };
  it("returns the bare event when there are no filters", () => {
    expect(eventSummary({ ...base, event: "push" })).toBe("push");
  });
  it("appends cron for schedule", () => {
    expect(eventSummary({ ...base, event: "schedule", cron: ["0 0 * * *"] })).toBe("schedule (0 0 * * *)");
  });
  it("appends types for activity events", () => {
    expect(eventSummary({ ...base, event: "pull_request", types: ["opened", "closed"] })).toBe(
      "pull_request (opened, closed)",
    );
  });
  it("joins cron and types when both are present", () => {
    expect(eventSummary({ ...base, event: "x", cron: ["a"], types: ["b"] })).toBe("x (a; b)");
  });
});
