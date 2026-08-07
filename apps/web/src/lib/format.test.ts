import { describe, it, expect, vi, afterEach } from "vitest";
import {
  toState,
  isFinished,
  STATE_LABEL,
  shortSha,
  shortRef,
  duration,
  humanDuration,
  absoluteTime,
  relativeTime,
  elapsedMs,
  timelineSpan,
  matrixLabel,
  humanSize,
  projectLabel,
  runDisplayName,
} from "./format";

describe("runDisplayName (#140)", () => {
  it("gives a filter-skipped run the file basename + (skipped), never the raw path", () => {
    expect(runDisplayName({ id: 7, fileName: ".github/workflows/ci.yml", status: "completed", result: "skipped" })).toBe(
      "ci.yml (skipped)",
    );
    expect(
      runDisplayName({
        id: 7,
        fileName: ".github/workflows/ci.yml",
        displayName: ".github/workflows/ci.yml",
        status: "completed",
        result: "skipped",
      }),
    ).toBe("ci.yml (skipped)");
  });

  it("keeps a real engine name on a skipped run when one exists", () => {
    expect(
      runDisplayName({ id: 7, fileName: ".github/workflows/ci.yml", displayName: "app-ci", result: "skipped" }),
    ).toBe("app-ci");
  });

  it("marks a skipped run with no file at all by its id", () => {
    expect(runDisplayName({ id: 7, result: "skipped" })).toBe("Run 7 (skipped)");
  });

  it("keeps the existing displayName → fileName → Run <id> ladder for executed runs", () => {
    expect(runDisplayName({ id: 6, fileName: ".github/workflows/ci.yml", displayName: "app-ci", result: "succeeded" })).toBe(
      "app-ci",
    );
    expect(runDisplayName({ id: 6, fileName: "release.yml" })).toBe("release.yml");
    expect(runDisplayName({ id: 6 })).toBe("Run 6");
  });
});

describe("projectLabel", () => {
  it("joins owner/repo when both are present", () => {
    expect(projectLabel({ owner: "acme", repo: "widget" })).toBe("acme/widget");
    expect(projectLabel({ owner: "Unknown", repo: "x" })).toBe("Unknown/x");
  });
  it("uses whichever half is present, trimming blanks", () => {
    expect(projectLabel({ repo: "widget" })).toBe("widget");
    expect(projectLabel({ owner: "acme" })).toBe("acme");
    expect(projectLabel({ owner: "  ", repo: "widget" })).toBe("widget");
  });
  it("falls back to 'local' when the run carries no project", () => {
    expect(projectLabel({})).toBe("local");
    expect(projectLabel({ owner: null, repo: null })).toBe("local");
  });
});

describe("toState", () => {
  it("lets a truthy result win over status", () => {
    expect(toState("pending", "succeeded")).toBe("success");
    expect(toState("running", "success")).toBe("success");
    expect(toState("x", "failed")).toBe("fail");
    expect(toState("x", "failure")).toBe("fail");
    expect(toState("x", "cancelled")).toBe("cancelled");
    expect(toState("x", "canceled")).toBe("cancelled");
    expect(toState("x", "skipped")).toBe("skipped");
  });

  it("falls back to status for unfinished states", () => {
    expect(toState("inprogress")).toBe("running");
    expect(toState("in_progress")).toBe("running");
    expect(toState("running")).toBe("running");
    expect(toState("completed")).toBe("success");
    expect(toState("done")).toBe("success");
    expect(toState("queued")).toBe("queued");
    expect(toState("pending")).toBe("queued");
    expect(toState("waiting")).toBe("queued");
  });

  it("returns unknown for anything unrecognized or absent", () => {
    expect(toState()).toBe("unknown");
    expect(toState(null, null)).toBe("unknown");
    expect(toState("weird", "weird")).toBe("unknown");
  });

  it("labels every state", () => {
    for (const s of Object.keys(STATE_LABEL)) {
      expect(STATE_LABEL[s as keyof typeof STATE_LABEL]).toBeTruthy();
    }
  });
});

describe("shortSha / shortRef", () => {
  it("truncates a sha to 7 chars, empty on nullish", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(shortSha()).toBe("");
    expect(shortSha(null)).toBe("");
  });

  it("strips heads/tags ref prefixes", () => {
    expect(shortRef("refs/heads/main")).toBe("main");
    expect(shortRef("refs/tags/v1.0")).toBe("v1.0");
    expect(shortRef("feature/x")).toBe("feature/x");
    expect(shortRef()).toBe("");
    expect(shortRef(null)).toBe("");
  });
});

describe("duration", () => {
  it("returns empty without a start", () => {
    expect(duration()).toBe("");
    expect(duration(null)).toBe("");
  });

  it("formats sub-second, seconds and minutes", () => {
    const t0 = "2020-01-01T00:00:00Z";
    expect(duration(t0, "2020-01-01T00:00:00.500Z")).toBe("500ms");
    expect(duration(t0, "2020-01-01T00:00:05Z")).toBe("5.00s");
    expect(duration(t0, "2020-01-01T00:00:12Z")).toBe("12.0s");
    expect(duration(t0, "2020-01-01T00:03:04Z")).toBe("3m 04s");
  });

  it("accepts naive (zone-less) timestamps as UTC", () => {
    expect(duration("2020-01-01T00:00:00", "2020-01-01T00:00:02")).toBe("2.00s");
  });

  it("returns empty for un-parseable or reversed spans", () => {
    expect(duration("not-a-date", "2020-01-01T00:00:00Z")).toBe("");
    expect(duration("2020-01-01T00:00:10Z", "2020-01-01T00:00:00Z")).toBe("");
  });

  it("measures against now when no finish is given", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:03Z"));
    expect(duration("2020-01-01T00:00:00Z")).toBe("3.00s");
    vi.useRealTimers();
  });
});

describe("relativeTime", () => {
  afterEach(() => vi.useRealTimers());

  function at(now: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  }

  it("empty on nullish / unparseable", () => {
    expect(relativeTime()).toBe("");
    expect(relativeTime(null)).toBe("");
    expect(relativeTime("nonsense")).toBe("");
  });

  it("walks every bucket", () => {
    at("2020-06-15T12:00:00Z");
    expect(relativeTime("2020-06-15T12:00:30Z")).toBe("just now"); // future → just now
    expect(relativeTime("2020-06-15T11:59:50Z")).toBe("just now"); // <45s
    expect(relativeTime("2020-06-15T11:58:50Z")).toBe("1m ago"); // <90s
    expect(relativeTime("2020-06-15T11:50:00Z")).toBe("10m ago");
    expect(relativeTime("2020-06-15T09:00:00Z")).toBe("3h ago");
    expect(relativeTime("2020-06-12T12:00:00Z")).toBe("3d ago");
    expect(relativeTime("2020-05-06T12:00:00Z")).toBe("1mo ago");
    expect(relativeTime("2018-06-15T12:00:00Z")).toBe("2y ago");
  });
});

describe("elapsedMs", () => {
  it("0 without start or on invalid/reversed span", () => {
    expect(elapsedMs()).toBe(0);
    expect(elapsedMs("bad", "2020-01-01T00:00:00Z")).toBe(0);
    expect(elapsedMs("2020-01-01T00:00:05Z", "2020-01-01T00:00:00Z")).toBe(0);
  });

  it("returns the ms span", () => {
    expect(elapsedMs("2020-01-01T00:00:00Z", "2020-01-01T00:00:02Z")).toBe(2000);
  });

  it("uses now for an open span", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:01Z"));
    expect(elapsedMs("2020-01-01T00:00:00Z")).toBe(1000);
    vi.useRealTimers();
  });
});

describe("timelineSpan", () => {
  it("collapses to nulls for an empty timeline", () => {
    expect(timelineSpan([])).toEqual({ start: null, finish: null });
  });

  it("takes earliest start and latest finish", () => {
    const span = timelineSpan([
      { startTime: "2020-01-01T00:00:02Z", finishTime: "2020-01-01T00:00:05Z" },
      { startTime: "2020-01-01T00:00:01Z", finishTime: "2020-01-01T00:00:03Z" },
    ]);
    expect(span.start).toBe("2020-01-01T00:00:01.000Z");
    expect(span.finish).toBe("2020-01-01T00:00:05.000Z");
  });

  it("reports an open finish when any record is still running", () => {
    const span = timelineSpan([
      { startTime: "2020-01-01T00:00:01Z", finishTime: "2020-01-01T00:00:03Z" },
      { startTime: "2020-01-01T00:00:02Z", finishTime: null },
    ]);
    expect(span.start).toBe("2020-01-01T00:00:01.000Z");
    expect(span.finish).toBeNull();
  });

  it("ignores un-parseable timestamps", () => {
    const span = timelineSpan([{ startTime: "bad", finishTime: "worse" }]);
    expect(span).toEqual({ start: null, finish: null });
  });
});

describe("matrixLabel", () => {
  it("null / empty inputs and bad JSON produce null", () => {
    expect(matrixLabel()).toBeNull();
    expect(matrixLabel(null)).toBeNull();
    expect(matrixLabel("{not json")).toBeNull();
    expect(matrixLabel("42")).toBeNull(); // not an object
    expect(matrixLabel("{}")).toBeNull(); // empty object
    expect(matrixLabel("[]")).toBeNull(); // empty array → first is undefined
  });

  it("joins entries of an object or the first array element", () => {
    expect(matrixLabel(JSON.stringify({ os: "linux", node: 20 }))).toBe("os: linux · node: 20");
    expect(matrixLabel(JSON.stringify([{ os: "mac" }]))).toBe("os: mac");
  });
});

describe("humanSize", () => {
  it("renders bytes through terabytes", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(158)).toBe("158 B");
    expect(humanSize(1024)).toBe("1.0 KB");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(20 * 1024)).toBe("20 KB");
    expect(humanSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(humanSize(2 * 1024 ** 4)).toBe("2.0 TB");
  });

  it("returns '' for missing or nonsensical values", () => {
    expect(humanSize()).toBe("");
    expect(humanSize(null)).toBe("");
    expect(humanSize(-1)).toBe("");
    expect(humanSize(Number.NaN)).toBe("");
  });
});

describe("humanDuration", () => {
  it("formats milliseconds through the same ladder as duration()", () => {
    expect(humanDuration(0)).toBe("0ms");
    expect(humanDuration(850)).toBe("850ms");
    expect(humanDuration(4100)).toBe("4.10s");
    expect(humanDuration(34000)).toBe("34.0s");
    expect(humanDuration(184000)).toBe("3m 04s");
  });

  it("returns '' for negative or non-finite input", () => {
    expect(humanDuration(-1)).toBe("");
    expect(humanDuration(Number.NaN)).toBe("");
    expect(humanDuration(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("absoluteTime", () => {
  it("renders a local absolute timestamp for a valid time", () => {
    expect(absoluteTime("2020-06-15T10:20:30Z")).toContain("2020");
  });

  it("zones a bare hub timestamp instead of failing to parse it", () => {
    expect(absoluteTime("2020-06-15 10:20:30")).toContain("2020");
  });

  it("returns '' for missing or unparseable input", () => {
    expect(absoluteTime(null)).toBe("");
    expect(absoluteTime(undefined)).toBe("");
    expect(absoluteTime("garbage")).toBe("");
  });
});

describe("isFinished", () => {
  it("is true for terminal states only", () => {
    expect(isFinished("success")).toBe(true);
    expect(isFinished("fail")).toBe(true);
    expect(isFinished("cancelled")).toBe(true);
    expect(isFinished("skipped")).toBe(true);
    expect(isFinished("running")).toBe(false);
    expect(isFinished("queued")).toBe(false);
    expect(isFinished("unknown")).toBe(false);
  });
});
