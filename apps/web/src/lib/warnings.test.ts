import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  collectAnnotations,
  countAnnotations,
  hasWarnings,
  fetchRunWarningCount,
  useRunWarnings,
} from "./warnings";
import type { Issue, TimelineRecord, WorkflowRun } from "./api";
import { mockFetch, routes } from "../test/helpers";

function rec(over: Partial<TimelineRecord> = {}): TimelineRecord {
  return {
    id: "r",
    parentId: null,
    type: "Task",
    name: "step",
    startTime: null,
    finishTime: null,
    state: "completed",
    result: "succeeded",
    percentComplete: 100,
    ...over,
  };
}

const warning = (message: string, data?: Issue["data"]): Issue => ({ type: "warning", message, data });
const error = (message: string, data?: Issue["data"]): Issue => ({ type: "error", message, data });

describe("collectAnnotations", () => {
  it("returns nothing for a genuinely clean job (no false positives)", () => {
    const records = [rec({ name: "Set up job" }), rec({ name: "Build" }), rec({ name: "Complete job" })];
    expect(collectAnnotations(records)).toEqual([]);
    expect(countAnnotations(records)).toBe(0);
  });

  it("detects a ##[warning] / ::warning:: as a warning annotation, carrying step + message", () => {
    const records = [
      rec({ name: "emit a warning", issues: [warning("this API is deprecated", { title: "Deprecation", stepNumber: "2" })] }),
    ];
    const out = collectAnnotations(records);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: "warning",
      message: "this API is deprecated",
      stepName: "emit a warning",
      stepNumber: 2,
    });
  });

  it("detects a non-fatal step failure (the #62 cache-save case) as an error annotation on a green step", () => {
    // The step's own result is still 'succeeded' (continue-on-error / post-step), but it
    // raised an error issue. Counting only 'warning' types would MISS this — the false negative
    // #62 is about. So error issues count too.
    const records = [
      rec({ name: "soft-failing step", result: "succeeded", issues: [error("Process completed with exit code 1.", { stepNumber: "3" })] }),
    ];
    const out = collectAnnotations(records);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("error");
    expect(out[0].stepName).toBe("soft-failing step");
  });

  it("detects retry-exhaustion surfaced as an issue and counts multiple across records", () => {
    const records = [
      rec({ name: "emit a warning", issues: [warning("deprecated input")] }),
      rec({ name: "Save cache", issues: [warning("Failed to save: cache service responded with 403 after 5 attempts")] }),
      rec({ name: "soft-failing step", issues: [error("Process completed with exit code 1.")] }),
    ];
    expect(countAnnotations(records)).toBe(3);
    expect(collectAnnotations(records).map((a) => a.stepName)).toEqual([
      "emit a warning",
      "Save cache",
      "soft-failing step",
    ]);
  });

  it("counts every issue on a single record, not just the first", () => {
    const records = [rec({ name: "noisy", issues: [warning("one"), warning("two"), error("three")] })];
    expect(countAnnotations(records)).toBe(3);
  });

  it("ignores notice/info issues — they are not warning signals", () => {
    const records = [
      rec({ name: "note", issues: [{ type: "notice", message: "heads up" }, { type: "info", message: "fyi" } as Issue] }),
    ];
    expect(collectAnnotations(records)).toEqual([]);
  });

  it("normalizes issue type casing", () => {
    const records = [rec({ issues: [{ type: "Warning", message: "w" }, { type: "ERROR", message: "e" }] })];
    expect(countAnnotations(records)).toBe(2);
  });

  it("survives missing issues arrays and empty messages", () => {
    const records = [
      rec({ name: "a", issues: null }),
      rec({ name: "b", issues: undefined }),
      rec({ name: "c", issues: [warning("")] }),
    ];
    const out = collectAnnotations(records);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe("(no message)");
  });

  it("parses stepNumber only when it is a finite number, else null", () => {
    const records = [
      rec({ issues: [warning("n", { stepNumber: "5" })] }),
      rec({ issues: [warning("empty", { stepNumber: "" })] }),
      rec({ issues: [warning("nan", { stepNumber: "x" })] }),
      rec({ issues: [warning("nodata")] }),
    ];
    expect(collectAnnotations(records).map((a) => a.stepNumber)).toEqual([5, null, null, null]);
  });
});

describe("hasWarnings", () => {
  it("is true only when a record carries a warning or non-fatal error issue", () => {
    expect(hasWarnings(rec({ issues: [warning("w")] }))).toBe(true);
    expect(hasWarnings(rec({ issues: [error("e")] }))).toBe(true);
    expect(hasWarnings(rec({ issues: [{ type: "notice", message: "n" }] }))).toBe(false);
    expect(hasWarnings(rec({ issues: [] }))).toBe(false);
    expect(hasWarnings(rec({}))).toBe(false);
  });
});

describe("fetchRunWarningCount", () => {
  it("returns 0 when the run has no attempts", async () => {
    mockFetch(routes({ "/run/1/attempts": [] }));
    expect(await fetchRunWarningCount(1)).toBe(0);
  });

  it("sums annotations across the latest attempt's jobs", async () => {
    mockFetch(
      routes({
        "/run/1/attempts": [{ id: 1, attempt: 1 }, { id: 2, attempt: 2 }],
        // Only the latest attempt (2) is read.
        "/attempt/2/jobs": [
          { jobId: "a", timeLineId: "tlA" },
          { jobId: "b", timeLineId: "tlB" },
        ],
        "/Timeline/tlA": [rec({ issues: [warning("w1")] }), rec({ issues: [error("e1")] })],
        "/Timeline/tlB": [rec({ issues: [warning("w2")] })],
      }),
    );
    expect(await fetchRunWarningCount(1)).toBe(3);
  });

  it("treats a job whose timeline fails to load as contributing 0 (never throws)", async () => {
    mockFetch(
      routes({
        "/run/1/attempts": [{ id: 1, attempt: 1 }],
        "/attempt/1/jobs": [
          { jobId: "a", timeLineId: "tlA" },
          { jobId: "b", timeLineId: "tlBoom" },
        ],
        "/Timeline/tlA": [rec({ issues: [warning("w")] })],
        "/Timeline/tlBoom": { status: 500 },
      }),
    );
    expect(await fetchRunWarningCount(1)).toBe(1);
  });
});

describe("useRunWarnings", () => {
  const success = (id: number): WorkflowRun => ({ id, status: "completed", result: "succeeded" });

  it("resolves a count for success runs and skips failed/running ones", async () => {
    mockFetch(
      routes({
        "/run/1/attempts": [{ id: 1, attempt: 1 }],
        "/attempt/1/jobs": [{ jobId: "a", timeLineId: "tl1" }],
        "/Timeline/tl1": [rec({ issues: [warning("w"), error("e")] })],
      }),
    );
    const runs: WorkflowRun[] = [
      success(1),
      { id: 2, status: "completed", result: "failed" },
      { id: 3, status: "inProgress", result: null },
    ];
    const { result } = renderHook(() => useRunWarnings(runs));
    await waitFor(() => expect(result.current[1]).toBe(2));
    // Failed and running runs are never probed → absent from the map.
    expect(result.current[2]).toBeUndefined();
    expect(result.current[3]).toBeUndefined();
  });

  it("records 0 when a success run's warning lookup rejects outright", async () => {
    mockFetch(routes({ "/run/9/attempts": { throw: true } }));
    const { result } = renderHook(() => useRunWarnings([success(9)]));
    await waitFor(() => expect(result.current[9]).toBe(0));
  });

  it("fetches each run once and reuses the cache across re-renders", async () => {
    const fn = mockFetch(
      routes({
        "/run/1/attempts": [{ id: 1, attempt: 1 }],
        "/attempt/1/jobs": [{ jobId: "a", timeLineId: "tl1" }],
        "/Timeline/tl1": [rec({ issues: [warning("w")] })],
      }),
    );
    const runs = [success(1)];
    const { result, rerender } = renderHook(({ r }) => useRunWarnings(r), { initialProps: { r: runs } });
    await waitFor(() => expect(result.current[1]).toBe(1));
    const callsAfterFirst = fn.mock.calls.length;
    // A fresh array reference (as polling produces) must not trigger a refetch.
    rerender({ r: [success(1)] });
    await waitFor(() => expect(result.current[1]).toBe(1));
    expect(fn.mock.calls.length).toBe(callsAfterFirst);
  });
});
