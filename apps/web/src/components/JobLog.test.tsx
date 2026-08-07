import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { JobLog } from "./JobLog";
import type { Job, TimelineRecord } from "../lib/api";
import { MockEventSource, mockFetch, routes } from "../test/helpers";

function job(over: Partial<Job>): Job {
  return {
    jobId: "j1",
    requestId: 1,
    timeLineId: "tl1",
    name: "build",
    workflowIdentifier: "wf",
    matrix: null,
    runid: 1,
    attempt: 1,
    status: "completed",
    result: "succeeded",
    ...over,
  };
}

function task(over: Partial<TimelineRecord>): TimelineRecord {
  return {
    id: "s",
    parentId: null,
    type: "Task",
    name: "step",
    startTime: "2020-01-01T00:00:00Z",
    finishTime: "2020-01-01T00:00:02Z",
    state: "completed",
    result: "succeeded",
    percentComplete: 100,
    order: 1,
    ...over,
  };
}

function scrollEl(): HTMLElement {
  return document.querySelector(".overflow-auto") as HTMLElement;
}

describe("JobLog — non-streaming states", () => {
  it("shows a skeleton while loading with nothing yet", () => {
    const { container } = render(<JobLog runId={1} job={undefined} records={null} loading />);
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("prompts to select a job when none is chosen", () => {
    render(<JobLog runId={1} job={undefined} records={null} loading={false} />);
    expect(screen.getByText("Select a job to see its steps.")).toBeTruthy();
  });

  it("shows 'loading logs' while the historical fetch is in flight", () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch; // never resolves
    render(<JobLog runId={1} job={job({})} records={[]} loading={false} />);
    expect(screen.getByText("Loading logs…")).toBeTruthy();
  });

  it("reports when console output was not retained (no steps)", async () => {
    mockFetch(routes({ "/api/local/joblogs/": { retained: false, lines: [] } }));
    render(<JobLog runId={1} job={job({})} records={[]} loading={false} />);
    await waitFor(() => expect(screen.getByText("Console output was not retained for this run.")).toBeTruthy());
  });

  it("renders read-only step rows plus the retained job log", async () => {
    mockFetch(routes({ "/api/local/joblogs/": { retained: true, lines: ["##[group]Summary", "done", "##[endgroup]"] } }));
    render(
      <JobLog
        runId={1}
        job={job({})}
        records={[task({ id: "a", name: "Checkout", order: 1 }), task({ id: "b", name: "Build", order: 2 })]}
        loading={false}
      />,
    );
    await waitFor(() => expect(screen.getByText("Job log")).toBeTruthy());
    expect(screen.getByText("Checkout")).toBeTruthy();
    expect(screen.getByText("Build")).toBeTruthy();
    expect(screen.getByText("Summary")).toBeTruthy(); // group from the retained log
  });

  it("shows a not-retained note beneath steps when nothing was kept", async () => {
    mockFetch(routes({ "/api/local/joblogs/": { retained: false, lines: [] } }));
    render(<JobLog runId={1} job={job({})} records={[task({ id: "a", name: "Only" })]} loading={false} />);
    await waitFor(() => expect(screen.getByText("Console output was not retained for this run.")).toBeTruthy());
    expect(screen.getByText("Only")).toBeTruthy();
  });

  it("shows a loading note beneath steps while the log is fetched", () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<JobLog runId={1} job={job({})} records={[task({ id: "a", name: "Only" })]} loading={false} />);
    expect(screen.getByText("Loading logs…")).toBeTruthy();
    expect(screen.getByText("Only")).toBeTruthy();
  });
});

describe("JobLog — live streaming", () => {
  const activeJob = job({ status: "inProgress", result: null });
  const steps = [
    task({ id: "s1", name: "Checkout", order: 1, state: "completed", result: "succeeded" }),
    task({ id: "s2", name: "Build", order: 2, state: "inProgress", result: null, finishTime: null }),
    task({ id: "s3", name: "Test", order: 3, state: "pending", result: null, finishTime: null }),
  ];

  // NOTE: these were one mega-test that flaked on CI. It emitted a 5001-line
  // frame and then ran ~8 more operations, each of which re-rendered or scanned
  // those ~5000 <pre> nodes — O(5000) DOM work repeated many times, whose
  // wall-clock is variable enough to blow the 5s default timeout on a slow
  // runner (not a hang or race). Split into small, synchronously-driven cases so
  // each is fast and a failure is attributable; the heavy MAX_LINES case is
  // isolated (nothing re-renders on top of it) at the end.

  it("shows connection status and reacts to open/error", () => {
    mockFetch(() => ({ status: 404 })); // no historical fetch while active
    render(<JobLog runId={1} job={activeJob} records={steps} loading={false} />);

    // Live header, initially not connected.
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByText("Pinned")).toBeTruthy();

    const es = MockEventSource.last();
    expect(es.url).toContain("timelineId=tl1");

    act(() => es.open());
    expect(screen.getByText("Streaming")).toBeTruthy();
    act(() => es.error());
    expect(screen.getByText("Idle")).toBeTruthy();
  });

  it("auto-expands the running step and prompts to wait for output", () => {
    mockFetch(() => ({ status: 404 }));
    render(<JobLog runId={1} job={activeJob} records={steps} loading={false} />);
    // The running step (Build) auto-expands and, with no output yet, waits.
    expect(screen.getByText("Waiting for output…")).toBeTruthy();
  });

  it("routes frames by explicit step, running-step fallback, and strips ANSI", () => {
    mockFetch(() => ({ status: 404 }));
    render(<JobLog runId={1} job={activeJob} records={steps} loading={false} />);
    const es = MockEventSource.last();

    // Frame routed by explicit stepId → appears under Build.
    act(() => es.emit("log", { record: { value: ["\x1b[32mhello", "world"], stepId: "s2" } }));
    expect(screen.getByText("hello")).toBeTruthy(); // ANSI stripped
    expect(screen.getByText("world")).toBeTruthy();

    // Frame with no stepId → routed to the running step.
    act(() => es.emit("log", { record: { value: ["auto-routed"] } }));
    expect(screen.getByText("auto-routed")).toBeTruthy();

    // Frame with an unknown stepId → still routed to the running step.
    act(() => es.emit("log", { record: { value: ["fallback-routed"], stepId: "ghost" } }));
    expect(screen.getByText("fallback-routed")).toBeTruthy();
  });

  it("ignores empty and malformed frames without throwing", () => {
    mockFetch(() => ({ status: 404 }));
    render(<JobLog runId={1} job={activeJob} records={steps} loading={false} />);
    const es = MockEventSource.last();
    act(() => es.emit("log", { record: { value: [] } }));
    act(() => es.emit("log", "{ not json"));
    // Nothing was appended; the running step still waits.
    expect(screen.getByText("Waiting for output…")).toBeTruthy();
  });

  it("shows a no-output note and toggles steps open/closed", () => {
    mockFetch(() => ({ status: 404 }));
    render(<JobLog runId={1} job={activeJob} records={steps} loading={false} />);
    // Steps with no captured output show a note (rendered for every step; the
    // collapse is CSS-only). Toggle Checkout open (add) and Build closed (delete)
    // to exercise both sides of the expand toggle.
    fireEvent.click(screen.getByRole("button", { name: /Checkout/ }));
    fireEvent.click(screen.getByRole("button", { name: /Build/ }));
    expect(screen.getAllByText("No output captured for this step.").length).toBeGreaterThan(0);
  });

  it("unpins on scroll away from the bottom and re-pins via the button", () => {
    mockFetch(() => ({ status: 404 }));
    render(<JobLog runId={1} job={activeJob} records={steps} loading={false} />);
    const el = scrollEl();
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(el);
    expect(screen.getByText("Pin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Pin/ }));
    expect(screen.getByText("Pinned")).toBeTruthy();
  });

  it("tears down the stream when the selected job changes", () => {
    mockFetch(() => ({ status: 404 }));
    const { rerender } = render(<JobLog runId={1} job={activeJob} records={steps} loading={false} />);
    const es = MockEventSource.last();

    // Switching to a finished job tears down the stream and resets state.
    mockFetch(routes({ "/api/local/joblogs/": { retained: false, lines: [] } }));
    rerender(<JobLog runId={1} job={job({ jobId: "j2", timeLineId: "tl2" })} records={[]} loading={false} />);
    expect(es.closed).toBe(true);
  });

  // Isolated on purpose: rendering >5000 log lines is a bounded but heavy jsdom
  // operation. Keeping it alone (no further re-renders pile on top) makes it
  // deterministic; the raised timeout is only a belt-and-braces guard for a
  // constrained CI runner, not a fix for a race.
  it(
    "caps live output at MAX_LINES (keeps the most recent 5000 lines)",
    () => {
      mockFetch(() => ({ status: 404 }));
      const single = [
        task({ id: "s2", name: "Build", order: 1, state: "inProgress", result: null, finishTime: null }),
      ];
      render(<JobLog runId={1} job={activeJob} records={single} loading={false} />);
      const es = MockEventSource.last();

      act(() =>
        es.emit("log", {
          record: { value: Array.from({ length: 5001 }, (_, i) => `L${i}`), stepId: "s2" },
        }),
      );
      // Over-cap by one → the oldest line (L0) is dropped, the newest (L5000) kept.
      expect(screen.getByText("L5000")).toBeTruthy();
      expect(screen.queryByText("L0")).toBeNull();
    },
    20000,
  );

  it("streams job-level output when the job has no steps yet", async () => {
    mockFetch(() => ({ status: 404 }));
    render(<JobLog runId={1} job={activeJob} records={[]} loading={false} />);
    // No steps and no output yet → waiting note.
    expect(screen.getByText("Waiting for the runner to start this job.")).toBeTruthy();

    const es = MockEventSource.last();
    act(() => es.emit("log", { record: { value: ["job-level line"] } }));
    expect(screen.getByText("job-level line")).toBeTruthy();
  });
});
