import { describe, it, expect } from "vitest";
import { deriveProjects, projectKind, workflowKey, workflowLabel, workflowFileName } from "./projects";
import type { WorkflowRun } from "./api";

const run = (r: Partial<WorkflowRun> & { id: number }): WorkflowRun => ({
  fileName: ".github/workflows/ci.yml",
  displayName: "CI",
  owner: "acme",
  repo: "widget",
  status: "completed",
  result: "succeeded",
  ...r,
});

describe("workflow identity helpers", () => {
  it("keys by fileName, then displayName, then a run fallback", () => {
    expect(workflowKey(run({ id: 1 }))).toBe(".github/workflows/ci.yml");
    expect(workflowKey({ id: 2, displayName: "Deploy" })).toBe("Deploy");
    expect(workflowKey({ id: 3 })).toBe("run-3");
  });
  it("labels by displayName, then fileName, then a run fallback", () => {
    expect(workflowLabel(run({ id: 1 }))).toBe("CI");
    expect(workflowLabel({ id: 2, fileName: "x.yml" })).toBe("x.yml");
    expect(workflowLabel({ id: 3 })).toBe("Run 3");
  });
  it("reduces a path fileName to its basename, else falls back", () => {
    expect(workflowFileName(run({ id: 1 }))).toBe("ci.yml");
    expect(workflowFileName({ id: 2, fileName: "flat.yml" })).toBe("flat.yml");
    expect(workflowFileName({ id: 3, displayName: "Named" })).toBe("Named");
    expect(workflowFileName({ id: 4 })).toBe("run-4");
    // A trailing-slash oddity falls back to the raw string rather than "".
    expect(workflowFileName({ id: 5, fileName: "a/" })).toBe("a/");
  });
});

describe("deriveProjects", () => {
  it("groups runs into projects and counts them, newest run as lastRun (max id)", () => {
    const projects = deriveProjects([
      run({ id: 3, owner: "acme", repo: "alpha", fileName: "ci.yml", displayName: "CI" }),
      run({ id: 2, owner: "globex", repo: "beta", fileName: "test.yml", displayName: "Test" }),
      run({ id: 1, owner: "acme", repo: "alpha", fileName: "ci.yml", displayName: "CI" }),
    ]);
    // Sorted by name.
    expect(projects.map((p) => p.name)).toEqual(["acme/alpha", "globex/beta"]);
    const alpha = projects[0];
    expect(alpha.runCount).toBe(2);
    expect(alpha.lastRun.id).toBe(3);
    expect(alpha.lastRunId).toBe(3);
  });

  it("splits a project's runs into distinct workflows, each with its own count + latest run", () => {
    const projects = deriveProjects([
      run({ id: 5, fileName: "ci.yml", displayName: "CI" }),
      run({ id: 6, fileName: "release.yml", displayName: "Release" }),
      run({ id: 7, fileName: "ci.yml", displayName: "CI" }),
    ]);
    expect(projects).toHaveLength(1);
    const wf = projects[0].workflows;
    // Sorted by label: CI before Release.
    expect(wf.map((w) => w.label)).toEqual(["CI", "Release"]);
    const ci = wf[0];
    expect(ci.runCount).toBe(2);
    expect(ci.latestRunId).toBe(7); // most recent CI run
    expect(ci.fileName).toBe("ci.yml");
    const release = wf[1];
    expect(release.runCount).toBe(1);
    expect(release.latestRunId).toBe(6);
  });

  it("falls projects with no owner/repo back to a 'local' project, marked unattributed", () => {
    const projects = deriveProjects([{ id: 1, fileName: "ci.yml", displayName: "CI" }]);
    expect(projects[0].name).toBe("local");
    expect(projects[0].kind).toBe("unattributed");
  });

  it("returns [] for no runs", () => {
    expect(deriveProjects([])).toEqual([]);
  });

  it("derives every project from a large history with exact counts (no page can hide one)", () => {
    // 51 runs, newest 30 all acme/alpha — a page-0 derivation would show ONE project.
    const runs: WorkflowRun[] = [];
    let id = 0;
    const push = (owner: string, repo: string, fileName: string) =>
      runs.push(run({ id: ++id, owner, repo, fileName, displayName: fileName }));
    for (let i = 0; i < 5; i++) push("globex", "beta", "test.yml");
    for (let i = 0; i < 3; i++) push("initech", "gamma", "deploy.yml");
    for (let i = 0; i < 2; i++) push("local", "scratch", "ci.yml");
    push("Unknown", "Unknown", "old.yml");
    for (let i = 0; i < 40; i++) push("acme", "alpha", "ci.yml");
    const newest30 = [...runs].sort((a, b) => b.id - a.id).slice(0, 30);
    expect(newest30.every((r) => r.owner === "acme")).toBe(true);

    const projects = deriveProjects(runs);
    expect(projects.map((p) => [p.name, p.kind, p.runCount, p.lastRunId])).toEqual([
      ["acme/alpha", "repo", 40, 51],
      ["globex/beta", "repo", 5, 5],
      ["initech/gamma", "repo", 3, 8],
      ["local/scratch", "local", 2, 10],
      ["Unknown/Unknown", "unattributed", 1, 11],
    ]);
  });

  it("keeps distinct local slugs and Unknown/Unknown as separate rows — never one merged project", () => {
    const projects = deriveProjects([
      run({ id: 1, owner: "local", repo: "app" }),
      run({ id: 2, owner: "local", repo: "lib" }),
      run({ id: 3, owner: "Unknown", repo: "Unknown" }),
      run({ id: 4, owner: "local", repo: "app" }),
    ]);
    expect(projects.map((p) => [p.name, p.kind, p.runCount])).toEqual([
      ["local/app", "local", 2],
      ["local/lib", "local", 1],
      ["Unknown/Unknown", "unattributed", 1],
    ]);
  });
});

describe("projectKind", () => {
  it("classifies repo / local slug / unattributed shapes", () => {
    expect(projectKind({ owner: "acme", repo: "alpha" })).toBe("repo");
    expect(projectKind({ owner: "local", repo: "scratch" })).toBe("local");
    expect(projectKind({ owner: "Unknown", repo: "Unknown" })).toBe("unattributed");
    expect(projectKind({ owner: "acme", repo: "Unknown" })).toBe("unattributed");
    expect(projectKind({})).toBe("unattributed");
    expect(projectKind({ owner: "acme" })).toBe("unattributed");
    expect(projectKind({ repo: "alpha" })).toBe("unattributed");
  });
});
