import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RunRow } from "./RunRow";
import type { WorkflowRun } from "../lib/api";
import { renderWithRouter, mockFetch } from "../test/helpers";

afterEach(() => vi.useRealTimers());

/** RunRow on a list page plus a detail route, to observe navigate-on-rerun. */
function renderRowWithDetailRoute(onRerun?: () => void) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route
          path="/"
          element={<RunRow run={{ id: 42, status: "completed", result: "succeeded" }} onRerun={onRerun} />}
        />
        <Route path="/runs/:id" element={<div>Run detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunRow re-run affordance", () => {
  it("offers a Re-run on a finished run", () => {
    renderWithRouter(<RunRow run={{ id: 42, status: "completed", result: "succeeded" }} />);
    expect(screen.getByLabelText("Re-run run 42")).toBeTruthy();
  });

  it("hides the Re-run while a run is still in progress", () => {
    renderWithRouter(<RunRow run={{ id: 42, status: "inProgress", result: null }} />);
    expect(screen.queryByLabelText("Re-run run 42")).toBeNull();
  });

  it("navigates to the run's detail after a successful list-row re-run", async () => {
    mockFetch((url) => (url.includes("/rerunworkflow/42") ? { status: 200, body: {} } : { status: 404 }));
    const onRerun = vi.fn();
    renderRowWithDetailRoute(onRerun);
    fireEvent.click(screen.getByLabelText("Re-run run 42"));
    // The user lands on the run, where the detail view follows the new attempt live.
    await waitFor(() => expect(screen.getByText("Run detail page")).toBeTruthy());
    expect(onRerun).toHaveBeenCalledTimes(1);
  });

  it("stays on the list when the re-run POST fails", async () => {
    mockFetch((url) => (url.includes("/rerunworkflow/42") ? { status: 502 } : { status: 404 }));
    renderRowWithDetailRoute();
    fireEvent.click(screen.getByLabelText("Re-run run 42"));
    await waitFor(() =>
      expect(screen.getByLabelText("Re-run run 42").className).toContain("text-fail"),
    );
    expect(screen.queryByText("Run detail page")).toBeNull();
  });
});

describe("RunRow run timing (#96)", () => {
  it("finished run: renders finish-relative time + duration from meta, absolute times on hover", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:10:00Z"));
    const run: WorkflowRun = { id: 9, displayName: "CI", status: "completed", result: "succeeded" };
    renderWithRouter(
      <RunRow
        run={run}
        meta={{ startedAt: "2020-01-01T00:00:00.000Z", finishedAt: "2020-01-01T00:00:04.100Z", durationMs: 4100 }}
      />,
    );
    expect(screen.getByText("10m ago")).toBeTruthy();
    expect(screen.getByText("4.10s")).toBeTruthy();
    const title = screen.getByTitle(/Started /).getAttribute("title") ?? "";
    expect(title).toContain("Started ");
    expect(title).toContain(" · Finished ");
  });

  it("in-progress run: renders a live 'running for …' with the start time on hover", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:34Z"));
    const run: WorkflowRun = { id: 10, displayName: "CI", status: "inProgress", result: null };
    renderWithRouter(<RunRow run={run} meta={{ startedAt: "2020-01-01T00:00:00.000Z" }} />);
    expect(screen.getByText("running for 34.0s")).toBeTruthy();
    const title = screen.getByTitle(/Started /).getAttribute("title") ?? "";
    expect(title).toMatch(/^Started /);
    expect(title).not.toContain("Finished");
  });

  it("no meta and no createdOn: the time slot stays empty (nothing fabricated)", () => {
    renderWithRouter(<RunRow run={{ id: 11, displayName: "CI", status: "completed", result: "succeeded" }} />);
    expect(screen.queryByText(/ago$/)).toBeNull();
    expect(screen.queryByTitle(/Started /)).toBeNull();
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
