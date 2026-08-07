import { describe, it, expect, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { RunRow } from "./RunRow";
import type { WorkflowRun } from "../lib/api";
import { renderWithRouter } from "../test/helpers";

afterEach(() => vi.useRealTimers());

describe("RunRow re-run affordance", () => {
  it("offers a Re-run on a finished run", () => {
    renderWithRouter(<RunRow run={{ id: 42, status: "completed", result: "succeeded" }} />);
    expect(screen.getByLabelText("Re-run run 42")).toBeTruthy();
  });

  it("hides the Re-run while a run is still in progress", () => {
    renderWithRouter(<RunRow run={{ id: 42, status: "inProgress", result: null }} />);
    expect(screen.queryByLabelText("Re-run run 42")).toBeNull();
  });
});

describe("RunRow", () => {
  it("renders full metadata: title, repo, ref, sha, event and relative time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:01:00Z"));
    const run: WorkflowRun = {
      id: 42,
      displayName: "CI",
      eventName: "push",
      owner: "acme",
      repo: "widget",
      ref: "refs/heads/main",
      sha: "abcdef1234",
      createdOn: "2020-01-01T00:00:00Z",
      status: "completed",
      result: "succeeded",
    };
    renderWithRouter(<RunRow run={run} />);
    expect(screen.getByText("CI")).toBeTruthy();
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByText("push")).toBeTruthy();
    expect(screen.getByText("acme/widget")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("abcdef1")).toBeTruthy();
    expect(screen.getByText("1m ago")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/runs/42");
  });

  it("always shows the project label (owner/repo), even when owner is Unknown", () => {
    const run: WorkflowRun = {
      id: 7,
      owner: "Unknown",
      repo: "x",
    };
    renderWithRouter(<RunRow run={run} />);
    expect(screen.getByText("Run 7")).toBeTruthy();
    // Previously hidden when owner was 'Unknown' — now every run visibly carries its project.
    expect(screen.getByText("Unknown/x")).toBeTruthy();
  });

  it("falls back to a 'local' project label when the run carries no owner/repo", () => {
    renderWithRouter(<RunRow run={{ id: 8 }} />);
    expect(screen.getByText("local")).toBeTruthy();
  });

  it("uses fileName when there is no displayName", () => {
    renderWithRouter(<RunRow run={{ id: 3, fileName: "ci.yml" }} />);
    expect(screen.getByText("ci.yml")).toBeTruthy();
  });

  it("shows the amber warning marker for a green run carrying warnings", () => {
    const run: WorkflowRun = { id: 5, fileName: "ci.yml", status: "completed", result: "succeeded" };
    renderWithRouter(<RunRow run={run} warnings={2} />);
    expect(screen.getByLabelText("2 warnings")).toBeTruthy();
  });

  it("omits the marker for a clean green run", () => {
    const run: WorkflowRun = { id: 6, fileName: "ci.yml", status: "completed", result: "succeeded" };
    renderWithRouter(<RunRow run={run} warnings={0} />);
    expect(screen.queryByLabelText(/warning/)).toBeNull();
  });

  it("never marks a failed run, even if warnings are reported", () => {
    const run: WorkflowRun = { id: 7, fileName: "ci.yml", status: "completed", result: "failed" };
    renderWithRouter(<RunRow run={run} warnings={3} />);
    expect(screen.queryByLabelText(/warning/)).toBeNull();
  });
});
