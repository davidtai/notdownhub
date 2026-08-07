import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RunDetail } from "./RunDetail";
import { ThemeProvider } from "../lib/theme";
import { mockFetch } from "../test/helpers";

function renderDetail(id = "5") {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[`/runs/${id}`]}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetail />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const taskRec = {
  id: "t1",
  parentId: null,
  type: "Task",
  name: "Checkout",
  startTime: "2020-01-01T00:00:00Z",
  finishTime: "2020-01-01T00:00:03Z",
  state: "completed",
  result: "succeeded",
  percentComplete: 100,
  order: 1,
};

describe("RunDetail", () => {
  it("renders the run header, attempts and jobs from the run summary", async () => {
    mockFetch((url) => {
      if (url.includes("/workflow/runs"))
        return {
          body: [
            {
              id: 5,
              displayName: "Deploy",
              status: "completed",
              result: "succeeded",
              eventName: "push",
              ref: "refs/heads/main",
              sha: "abc1234def",
              owner: "acme",
              repo: "widget",
            },
          ],
        };
      if (url.includes("/run/5/attempts"))
        return {
          body: [
            { id: 1, attempt: 1, timeLineId: "at1" },
            { id: 2, attempt: 2, timeLineId: "at2" },
          ],
        };
      if (url.includes("/attempt/2/jobs"))
        return {
          body: [
            { jobId: "jA", timeLineId: "tlA", name: "build", matrix: null, workflowIdentifier: "build", status: "completed", result: "succeeded", requestId: 1, runid: 5, attempt: 2 },
            { jobId: "jB", timeLineId: "tlB", name: "test", matrix: null, workflowIdentifier: "test", status: "completed", result: "succeeded", requestId: 1, runid: 5, attempt: 2 },
          ],
        };
      if (url.includes("/attempt/1/jobs")) return { body: [] };
      if (url.includes("/Timeline/tlA")) return { body: [taskRec] };
      if (url.includes("/Timeline/tlB")) return { throw: true }; // exercises the per-timeline catch
      if (url.includes("/api/local/joblogs/")) return { body: { retained: true, lines: ["log line"] } };
      return { status: 404 };
    });

    const { container } = renderDetail();
    // Jobs card starts as a skeleton (jobs.initial).
    expect(container.querySelector(".animate-pulse")).toBeTruthy();

    await waitFor(() => expect(screen.getByText("Deploy")).toBeTruthy());
    expect(screen.getByText("#5")).toBeTruthy();
    expect(screen.getByText("Passed")).toBeTruthy();
    expect(screen.getByText("push")).toBeTruthy();
    expect(screen.getByText("acme/widget")).toBeTruthy(); // project shown on the run-detail header
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("abc1234")).toBeTruthy();

    // Attempt selector (two attempts) and jobs from attempt 2.
    expect(screen.getByText("Attempt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "2" })).toBeTruthy();
    // "build" is the selected job, so it appears in both the list and the log header.
    await waitFor(() => expect(screen.getAllByText("build").length).toBeGreaterThan(0));
    expect(screen.getByText("test")).toBeTruthy();

    // Selecting attempt 1 (which has no jobs) shows the empty message.
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    await waitFor(() => expect(screen.getByText("No jobs for this attempt yet.")).toBeTruthy());
  });

  it("falls back to the attempt for header details when there is no run summary, and selects a matrix leg", async () => {
    mockFetch((url) => {
      if (url.includes("/workflow/runs")) return { body: [] }; // no summary
      if (url.includes("/run/5/attempts"))
        return {
          body: [
            {
              id: 1,
              attempt: 1,
              status: "inProgress",
              result: null,
              ref: "refs/heads/dev",
              sha: "def5678aaa",
              eventName: "pull_request",
              timeLineId: "at1",
            },
          ],
        };
      if (url.includes("/attempt/1/jobs"))
        return {
          body: [
            { jobId: "jm", timeLineId: "tlm", name: "lint (linux)", matrix: '{"os":"linux"}', workflowIdentifier: "lint", status: "completed", result: "succeeded", requestId: 1, runid: 5, attempt: 1 },
            { jobId: "jp", timeLineId: "tlp", name: "lint", matrix: null, workflowIdentifier: "lint", status: "completed", result: "succeeded", requestId: 1, runid: 5, attempt: 1 },
          ],
        };
      if (url.includes("/Timeline/")) return { body: [] };
      if (url.includes("/api/local/joblogs/")) return { body: { retained: false, lines: [] } };
      return { status: 404 };
    });

    renderDetail();
    await waitFor(() => expect(screen.getByText("Run 5")).toBeTruthy());
    expect(screen.getByText("Running")).toBeTruthy(); // from the attempt
    expect(screen.getByText("dev")).toBeTruthy();
    expect(screen.getByText("def5678")).toBeTruthy();
    expect(screen.getByText("pull_request")).toBeTruthy();

    // A single attempt hides the attempt selector.
    expect(screen.queryByText("Attempt")).toBeNull();

    // The matrix group renders the leg label; the leg is auto-selected.
    await waitFor(() => expect(screen.getByText("os: linux")).toBeTruthy());
  });

  it("renders an unknown state with no attempts or jobs", async () => {
    mockFetch((url) => {
      if (url.includes("/workflow/runs")) return { body: [] };
      if (url.includes("/attempts")) return { body: [] };
      if (url.includes("/jobs")) return { body: [] };
      return { status: 404 };
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Run 5")).toBeTruthy());
    expect(screen.getByText("Unknown")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No jobs for this attempt yet.")).toBeTruthy());
  });
});
