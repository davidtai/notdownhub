import { describe, it, expect } from "vitest";
import { filterByTerms, matchesTerms, runHaystack, runnerHaystack } from "./filter";
import type { RunnerInfo, WorkflowRun } from "./api";

const run = (r: Partial<WorkflowRun>): WorkflowRun => ({ id: 1, ...r });

describe("runHaystack", () => {
  it("includes project, workflow, branch, event, and derived state — all lowercased", () => {
    const hay = runHaystack(
      run({
        id: 7,
        owner: "Acme",
        repo: "Widget",
        displayName: "CI",
        fileName: "ci.yml",
        ref: "refs/heads/Main",
        eventName: "Push",
        status: "completed",
        result: "succeeded",
      }),
    );
    expect(hay).toContain("acme/widget");
    expect(hay).toContain("ci");
    expect(hay).toContain("main");
    expect(hay).toContain("push");
    expect(hay).toContain("passed"); // STATE_LABEL for success
    expect(hay).toContain("#7");
    expect(hay).toBe(hay.toLowerCase());
  });

  it("omits missing fields without leaving 'undefined' in the text", () => {
    const hay = runHaystack(run({ id: 2 }));
    expect(hay).not.toContain("undefined");
    expect(hay).toContain("#2");
  });
});

describe("runnerHaystack", () => {
  it("includes name, labels, state, os and version", () => {
    const r: RunnerInfo = {
      id: 1,
      name: "runner-a",
      labels: ["self-hosted", "linux"],
      os: "Darwin 25",
      version: "3.1",
      online: true,
      busy: false,
      state: "idle",
    };
    const hay = runnerHaystack(r);
    expect(hay).toContain("runner-a");
    expect(hay).toContain("self-hosted");
    expect(hay).toContain("linux");
    expect(hay).toContain("idle");
    expect(hay).toContain("darwin 25");
    expect(hay).toContain("3.1");
  });
});

describe("matchesTerms", () => {
  it("requires every non-empty term (AND) and ignores blanks", () => {
    const hay = "acme/widget ci main push";
    expect(matchesTerms(hay, ["acme", "ci"])).toBe(true);
    expect(matchesTerms(hay, ["acme", "release"])).toBe(false);
    expect(matchesTerms(hay, ["  ", ""])).toBe(true); // all blank → matches
    expect(matchesTerms(hay, ["ACME"])).toBe(true); // case-insensitive
  });
});

describe("filterByTerms", () => {
  const runs = [
    run({ id: 1, owner: "acme", repo: "widget", fileName: "ci.yml", displayName: "CI" }),
    run({ id: 2, owner: "acme", repo: "widget", fileName: "release.yml", displayName: "Release" }),
    run({ id: 3, owner: "local", repo: "scratch", fileName: "ci.yml", displayName: "CI" }),
  ];

  it("returns the list unchanged when there are no active terms", () => {
    expect(filterByTerms(runs, [], runHaystack)).toHaveLength(3);
    expect(filterByTerms(runs, ["   "], runHaystack)).toHaveLength(3);
  });

  it("keeps items matching all terms (AND across pills)", () => {
    expect(filterByTerms(runs, ["acme"], runHaystack).map((r) => r.id)).toEqual([1, 2]);
    expect(filterByTerms(runs, ["acme", "ci"], runHaystack).map((r) => r.id)).toEqual([1]);
    expect(filterByTerms(runs, ["ci"], runHaystack).map((r) => r.id)).toEqual([1, 3]);
    expect(filterByTerms(runs, ["nope"], runHaystack)).toHaveLength(0);
  });
});
