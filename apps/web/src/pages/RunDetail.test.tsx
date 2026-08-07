import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RunDetail } from "./RunDetail";
import { ThemeProvider } from "../lib/theme";
import { mockFetch } from "../test/helpers";

function renderDetail(id = "5") {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[`/runs/${id}`]}>
        <Routes>
          <Route path="/" element={<div>Runs list page</div>} />
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

  it("shows an Artifacts section with a download link when the run has artifacts", async () => {
    mockFetch((url) => {
      if (url.includes("/workflow/runs")) return { body: [{ id: 5, displayName: "Deploy", status: "completed", result: "succeeded" }] };
      if (url.includes("/attempts")) return { body: [{ id: 1, attempt: 1, timeLineId: "at1" }] };
      if (url.includes("/jobs")) return { body: [] };
      if (url.includes("/api/local/artifacts/5")) return { body: [{ id: 5, name: "my-artifact", size: 158 }] };
      if (url.includes("/api/local/joblogs/")) return { body: { retained: false, lines: [] } };
      return { status: 404 };
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Artifacts")).toBeTruthy());
    expect(screen.getByText("my-artifact")).toBeTruthy();
    expect(screen.getByText("158 B")).toBeTruthy();
    const link = screen.getByLabelText("Download my-artifact") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/local/artifacts/5/my-artifact");
  });

  it("shows no Artifacts section for a run without artifacts", async () => {
    mockFetch((url) => {
      if (url.includes("/workflow/runs")) return { body: [{ id: 5, displayName: "Deploy", status: "completed", result: "succeeded" }] };
      if (url.includes("/attempts")) return { body: [] };
      if (url.includes("/jobs")) return { body: [] };
      if (url.includes("/api/local/artifacts/5")) return { body: [] };
      return { status: 404 };
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Deploy")).toBeTruthy());
    expect(screen.queryByText("Artifacts")).toBeNull();
  });

  it("cancels a running run from the header", async () => {
    const fn = mockFetch((url) => {
      if (url.includes("/workflow/runs")) return { body: [{ id: 5, displayName: "Deploy", status: "inprogress", result: null }] };
      if (url.includes("/attempts")) return { body: [{ id: 1, attempt: 1, timeLineId: "at1", status: "inprogress" }] };
      if (url.includes("/jobs")) return { body: [] };
      if (url.includes("/cancel")) return { status: 200 };
      return { status: 404 };
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel run 5" }));
    await waitFor(() =>
      expect(
        (fn.mock.calls as unknown[][]).some(
          ([u, i]) => String(u) === "/api/local/runs/5/cancel" && (i as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("deletes a run from the header and navigates back to the runs list", async () => {
    mockFetch((url) => {
      if (url.includes("/workflow/runs")) return { body: [{ id: 5, displayName: "Deploy", status: "completed", result: "succeeded" }] };
      if (url.includes("/attempts")) return { body: [{ id: 1, attempt: 1, timeLineId: "at1" }] };
      if (url.includes("/jobs")) return { body: [] };
      if (url.includes("/Timeline/")) return { body: [] };
      if (url.includes("/api/local/artifacts/5")) return { body: [] };
      if (url.includes("/api/local/joblogs/")) return { body: { retained: false, lines: [] } };
      if (url.includes("/api/local/runs/5")) return { status: 200 };
      return { status: 404 };
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Deploy")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete run 5" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Delete"));
    await waitFor(() => expect(screen.getByText("Runs list page")).toBeTruthy());
  });

  it("shows a not-found tombstone when a deleted run's detail 404s", async () => {
    mockFetch((url) => {
      if (url.includes("/workflow/runs")) return { body: [] }; // filtered out
      if (url.includes("/attempts")) return { status: 404 }; // detail 404s
      return { status: 404 };
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Run #5 not found")).toBeTruthy());
    expect(screen.getByText("It may have been deleted.")).toBeTruthy();
  });

  it("surfaces 'Passed with warnings' with a count when a green run has annotations", async () => {
    const warnStep = {
      id: "w",
      parentId: null,
      type: "Task",
      name: "emit a warning",
      startTime: "2020-01-01T00:00:00Z",
      finishTime: "2020-01-01T00:00:01Z",
      state: "completed",
      result: "succeeded",
      percentComplete: 100,
      order: 2,
      issues: [{ type: "warning", message: "this API is deprecated" }],
    };
    const softFail = {
      ...warnStep,
      id: "e",
      name: "soft-failing step",
      order: 3,
      issues: [{ type: "error", message: "Process completed with exit code 1." }],
    };
    mockFetch((url) => {
      if (url.includes("/workflow/runs"))
        return { body: [{ id: 5, displayName: "Noisy CI", status: "completed", result: "succeeded" }] };
      if (url.includes("/run/5/attempts")) return { body: [{ id: 1, attempt: 1, timeLineId: "at1" }] };
      if (url.includes("/attempt/1/jobs"))
        return {
          body: [
            { jobId: "jA", timeLineId: "tlA", name: "build", matrix: null, workflowIdentifier: "build", status: "completed", result: "succeeded", requestId: 1, runid: 5, attempt: 1 },
          ],
        };
      if (url.includes("/Timeline/tlA")) return { body: [taskRec, warnStep, softFail] };
      if (url.includes("/api/local/joblogs/")) return { body: { retained: true, lines: ["done"] } };
      return { status: 404 };
    });

    renderDetail();
    // Run badge switches from plain "Passed" to the warnings variant with the total count (2).
    await waitFor(() => expect(screen.getByText("Passed with warnings")).toBeTruthy());
    expect(screen.queryByText("Passed")).toBeNull();
    // The annotation banner lists both messages above the log.
    await waitFor(() => expect(screen.getByText("this API is deprecated")).toBeTruthy());
    expect(screen.getByText("Process completed with exit code 1.")).toBeTruthy();
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

  it("offers a Re-run on a finished run and POSTs the hub's native re-run when clicked", async () => {
    let rerunPosts = 0;
    const fn = mockFetch((url) => {
      if (url.includes("/rerunworkflow/5")) {
        rerunPosts += 1;
        return { status: 200, body: {} };
      }
      if (url.includes("/workflow/runs"))
        return { body: [{ id: 5, displayName: "Deploy", status: "completed", result: "succeeded" }] };
      if (url.includes("/attempts")) return { body: [{ id: 1, attempt: 1, timeLineId: "at1" }] };
      if (url.includes("/jobs")) return { body: [] };
      if (url.includes("/Timeline/")) return { body: [] };
      return { status: 404 };
    });

    renderDetail();
    const btn = await screen.findByLabelText("Re-run run 5");
    fireEvent.click(btn);
    await waitFor(() => expect(rerunPosts).toBe(1));
    const call = fn.mock.calls.find((c) => String(c[0]).includes("/rerunworkflow/5"));
    expect((call?.[1] as { method?: string })?.method).toBe("POST");
  });

  it("auto-advances to the new attempt when a re-run adds one", async () => {
    let rerun = false;
    mockFetch((url) => {
      if (url.includes("/rerunworkflow/5")) {
        rerun = true;
        return { status: 200, body: {} };
      }
      if (url.includes("/workflow/runs"))
        return { body: [{ id: 5, displayName: "Deploy", status: "completed", result: "succeeded" }] };
      if (url.includes("/run/5/attempts"))
        return {
          body: rerun
            ? [
                { id: 1, attempt: 1, timeLineId: "at1" },
                { id: 2, attempt: 2, timeLineId: "at2" },
              ]
            : [{ id: 1, attempt: 1, timeLineId: "at1" }],
        };
      if (url.includes("/attempt/1/jobs"))
        return { body: [{ jobId: "j1", timeLineId: "tl1", name: "old-job", matrix: null, workflowIdentifier: "b", status: "completed", result: "succeeded", requestId: 1, runid: 5, attempt: 1 }] };
      if (url.includes("/attempt/2/jobs"))
        return { body: [{ jobId: "j2", timeLineId: "tl2", name: "new-job", matrix: null, workflowIdentifier: "b", status: "inProgress", result: null, requestId: 2, runid: 5, attempt: 2 }] };
      if (url.includes("/Timeline/")) return { body: [] };
      if (url.includes("/api/local/joblogs/")) return { body: { retained: false, lines: [] } };
      return { status: 404 };
    });

    renderDetail();
    await waitFor(() => expect(screen.getAllByText("old-job").length).toBeGreaterThan(0));
    expect(screen.queryByText("Attempt")).toBeNull(); // single attempt: no selector yet

    // Re-run → onDone refreshes attempts → the view follows the new attempt without a reload.
    fireEvent.click(await screen.findByLabelText("Re-run run 5"));
    await waitFor(() => expect(screen.getByRole("button", { name: "2" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "2" }).className).toContain("bg-accent");
    await waitFor(() => expect(screen.getAllByText("new-job").length).toBeGreaterThan(0));
  });

  it("keeps a manually pinned older attempt when a new attempt appears", async () => {
    let rerun = false;
    mockFetch((url) => {
      if (url.includes("/rerunworkflow/5")) {
        rerun = true;
        return { status: 200, body: {} };
      }
      if (url.includes("/workflow/runs"))
        return { body: [{ id: 5, displayName: "Deploy", status: "completed", result: "succeeded" }] };
      if (url.includes("/run/5/attempts"))
        return {
          body: [
            { id: 1, attempt: 1, timeLineId: "at1" },
            { id: 2, attempt: 2, timeLineId: "at2" },
            ...(rerun ? [{ id: 3, attempt: 3, timeLineId: "at3" }] : []),
          ],
        };
      if (url.includes("/jobs")) return { body: [] };
      if (url.includes("/Timeline/")) return { body: [] };
      return { status: 404 };
    });

    renderDetail();
    await waitFor(() => expect(screen.getByRole("button", { name: "2" }).className).toContain("bg-accent"));
    fireEvent.click(screen.getByRole("button", { name: "1" })); // pin attempt 1
    await waitFor(() => expect(screen.getByRole("button", { name: "1" }).className).toContain("bg-accent"));

    fireEvent.click(await screen.findByLabelText("Re-run run 5"));
    await waitFor(() => expect(screen.getByRole("button", { name: "3" })).toBeTruthy());
    // Still pinned to 1 — the user's explicit choice outranks the auto-advance.
    expect(screen.getByRole("button", { name: "1" }).className).toContain("bg-accent");
    expect(screen.getByRole("button", { name: "3" }).className).not.toContain("bg-accent");

    // Clicking the newest attempt returns to following mode.
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "3" }).className).toContain("bg-accent"));
  });

  it("hides the Re-run while a run is still in progress", async () => {
    mockFetch((url) => {
      if (url.includes("/workflow/runs"))
        return { body: [{ id: 5, displayName: "Deploy", status: "inProgress", result: null }] };
      if (url.includes("/attempts")) return { body: [{ id: 1, attempt: 1, timeLineId: "at1" }] };
      if (url.includes("/jobs")) return { body: [] };
      if (url.includes("/Timeline/")) return { body: [] };
      return { status: 404 };
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    expect(screen.queryByLabelText("Re-run run 5")).toBeNull();
  });
});
