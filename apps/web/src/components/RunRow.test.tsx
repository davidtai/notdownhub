import { describe, it, expect, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { RunRow } from "./RunRow";
import type { WorkflowRun } from "../lib/api";
import { renderWithRouter } from "../test/helpers";

afterEach(() => vi.useRealTimers());

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

  it("omits optional metadata and falls back to a Run # title", () => {
    const run: WorkflowRun = {
      id: 7,
      owner: "Unknown", // suppressed
      repo: "x",
    };
    renderWithRouter(<RunRow run={run} />);
    expect(screen.getByText("Run 7")).toBeTruthy();
    expect(screen.queryByText("Unknown/x")).toBeNull();
  });

  it("uses fileName when there is no displayName", () => {
    renderWithRouter(<RunRow run={{ id: 3, fileName: "ci.yml" }} />);
    expect(screen.getByText("ci.yml")).toBeTruthy();
  });
});
