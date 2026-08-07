import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useRunsMeta, runTimeCell } from "./runmeta";
import type { RunTimeMeta, WorkflowRun } from "./api";
import { mockFetch } from "../test/helpers";

afterEach(() => vi.useRealTimers());

const FINISHED: RunTimeMeta = {
  startedAt: "2020-01-01T00:00:00.000Z",
  finishedAt: "2020-01-01T00:00:04.100Z",
  durationMs: 4100,
};

describe("runTimeCell", () => {
  it("finished run: finish-relative primary, duration secondary, absolute times in the title", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:10:00Z"));
    const cell = runTimeCell("success", FINISHED);
    expect(cell?.primary).toBe("10m ago");
    expect(cell?.secondary).toBe("4.10s");
    expect(cell?.title).toContain("Started ");
    expect(cell?.title).toContain(" · Finished ");
  });

  it("finished run without a recorded duration: no secondary line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:10:00Z"));
    const cell = runTimeCell("success", { startedAt: FINISHED.startedAt, finishedAt: FINISHED.finishedAt });
    expect(cell?.primary).toBe("10m ago");
    expect(cell?.secondary).toBeUndefined();
  });

  it("running run: live 'running for …' from startedAt, started-absolute in the title", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:34Z"));
    const cell = runTimeCell("running", { startedAt: "2020-01-01T00:00:00.000Z" });
    expect(cell?.primary).toBe("running for 34.0s");
    expect(cell?.title).toMatch(/^Started /);
    expect(cell?.title).not.toContain("Finished");
  });

  it("startedAt only on a non-running run: started-relative, never a fabricated finish", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:05:00Z"));
    const cell = runTimeCell("cancelled", { startedAt: "2020-01-01T00:00:00.000Z" });
    expect(cell?.primary).toBe("5m ago");
    expect(cell?.secondary).toBeUndefined();
    expect(cell?.title).toMatch(/^Started /);
  });

  it("no meta: falls back to createdOn when the engine ever sends one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:03:00Z"));
    const cell = runTimeCell("success", undefined, "2020-01-01T00:00:00Z");
    expect(cell?.primary).toBe("3m ago");
    expect(cell?.title).toBeTruthy();
  });

  it("no meta and no createdOn: null (the row shows no time, nothing invented)", () => {
    expect(runTimeCell("success", undefined, null)).toBeNull();
    expect(runTimeCell("success", undefined, "garbage")).toBeNull();
  });
});

describe("useRunsMeta", () => {
  const finished = (id: number): WorkflowRun => ({ id, status: "completed", result: "succeeded" });
  const running = (id: number): WorkflowRun => ({ id, status: "inProgress", result: null });

  const metaCalls = (fn: ReturnType<typeof mockFetch>) =>
    fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/local/runs-meta"));

  it("resolves the whole page in ONE batched request, keyed by run id", async () => {
    const fetchFn = mockFetch((url) =>
      url.includes("/api/local/runs-meta")
        ? { body: { 1: FINISHED, 2: { startedAt: "2020-01-01T00:00:00.000Z" } } }
        : undefined,
    );
    const { result } = renderHook((p: { runs: WorkflowRun[] }) => useRunsMeta(p.runs), {
      initialProps: { runs: [finished(1), running(2)] },
    });
    await waitFor(() => expect(result.current[1]).toBeTruthy());
    expect(result.current[1].durationMs).toBe(4100);
    expect(result.current[2].startedAt).toBe("2020-01-01T00:00:00.000Z");
    const calls = metaCalls(fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("ids=1,2");
  });

  it("settles finished ids after one resolution; keeps re-asking about a running run", async () => {
    const fetchFn = mockFetch((url) =>
      url.includes("/api/local/runs-meta")
        ? { body: { 1: FINISHED, 2: { startedAt: "2020-01-01T00:00:00.000Z" } } }
        : undefined,
    );
    const runs1 = [finished(1), running(2)];
    const { result, rerender } = renderHook((p: { runs: WorkflowRun[] }) => useRunsMeta(p.runs), {
      initialProps: { runs: runs1 },
    });
    await waitFor(() => expect(result.current[1]).toBeTruthy());

    // Same runs, new array identity (a poll refresh) → only the running id is re-asked.
    rerender({ runs: [finished(1), running(2)] });
    await waitFor(() => expect(metaCalls(fetchFn)).toHaveLength(2));
    expect(metaCalls(fetchFn)[1]).toContain("ids=2");
    expect(metaCalls(fetchFn)[1]).not.toContain("1,");
  });

  it("a finished run the fleet never timed settles too — no request flood", async () => {
    const fetchFn = mockFetch((url) => (url.includes("/api/local/runs-meta") ? { body: {} } : undefined));
    const { rerender } = renderHook((p: { runs: WorkflowRun[] }) => useRunsMeta(p.runs), {
      initialProps: { runs: [finished(7)] },
    });
    await waitFor(() => expect(metaCalls(fetchFn)).toHaveLength(1));
    await act(async () => {}); // flush the settle
    rerender({ runs: [finished(7)] });
    await act(async () => {});
    expect(metaCalls(fetchFn)).toHaveLength(1); // settled: never asked again
  });

  it("an unavailable endpoint (older hub) settles nothing and retries on the next change", async () => {
    const fetchFn = mockFetch((url) => (url.includes("/api/local/runs-meta") ? { status: 404 } : undefined));
    const { result, rerender } = renderHook((p: { runs: WorkflowRun[] }) => useRunsMeta(p.runs), {
      initialProps: { runs: [finished(1)] },
    });
    await waitFor(() => expect(metaCalls(fetchFn)).toHaveLength(1));
    await act(async () => {});
    expect(result.current).toEqual({});
    rerender({ runs: [finished(1)] });
    await waitFor(() => expect(metaCalls(fetchFn)).toHaveLength(2)); // not settled → retried
  });

  it("asks nothing when every visible run is settled or the list is empty", async () => {
    const fetchFn = mockFetch(() => undefined);
    renderHook((p: { runs: WorkflowRun[] }) => useRunsMeta(p.runs), { initialProps: { runs: [] } });
    await act(async () => {});
    expect(metaCalls(fetchFn)).toHaveLength(0);
  });
});
