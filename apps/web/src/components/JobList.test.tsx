import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { JobList } from "./JobList";
import type { Job } from "../lib/api";

function job(over: Partial<Job>): Job {
  return {
    jobId: "j",
    requestId: 1,
    timeLineId: "tl",
    name: "job",
    workflowIdentifier: "wf",
    matrix: null,
    runid: 1,
    attempt: 1,
    status: "completed",
    result: "succeeded",
    ...over,
  };
}

const jobs: Job[] = [
  // plain job
  job({ jobId: "p1", workflowIdentifier: "build", name: "build" }),
  // matrix group WITH a parent
  job({ jobId: "tp", workflowIdentifier: "test", name: "test", status: "inprogress", result: null }),
  job({ jobId: "l1", workflowIdentifier: "test", name: "test (linux)", matrix: '{"os":"linux"}' }),
  job({ jobId: "l2", workflowIdentifier: "test", name: "test (mac)", matrix: '{"os":"mac"}' }),
  // matrix group WITHOUT a parent
  job({ jobId: "n1", workflowIdentifier: "lint", name: "lint", matrix: '{"os":"x"}' }),
  // empty workflowIdentifier → keyed by name
  job({ jobId: "e1", workflowIdentifier: "", name: "empty-key" }),
];

const durations: Record<string, number> = {
  p1: 500, // "500ms", tiny pct clamps to 4
  l1: 5000, // "5.0s"
  l2: 65000, // "1m 05s" (also the longest)
  n1: 15000, // "15s"
  e1: 0, // no duration, no bar
};

describe("JobList", () => {
  it("groups plain jobs, matrix legs (with and without a parent) and formats durations", () => {
    const onSelect = vi.fn();
    render(<JobList jobs={jobs} durations={durations} selectedJobId="l1" onSelect={onSelect} />);

    // plain + empty-key jobs
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("empty-key")).toBeTruthy();

    // matrix parent header + legs, labelled from the matrix
    expect(screen.getByText("test")).toBeTruthy();
    expect(screen.getByText("os: linux")).toBeTruthy();
    expect(screen.getByText("os: mac")).toBeTruthy();

    // parent-less group falls back to the identifier as its header
    expect(screen.getByText("lint")).toBeTruthy();
    expect(screen.getByText("os: x")).toBeTruthy();

    // durations across fmtMs branches
    expect(screen.getByText("500ms")).toBeTruthy();
    expect(screen.getByText("5.0s")).toBeTruthy();
    expect(screen.getByText("1m 05s")).toBeTruthy();
    expect(screen.getByText("15s")).toBeTruthy();

    // selected leg is marked
    expect(screen.getByText("os: linux").closest("button")?.getAttribute("aria-current")).toBe("true");
  });

  it("invokes onSelect with the clicked job", () => {
    const onSelect = vi.fn();
    render(<JobList jobs={jobs} durations={durations} selectedJobId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("build"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ jobId: "p1" }));
  });

  it("marks a green job and a green matrix group with a warning glyph, summing legs", () => {
    // A plain green job with 2 warnings, and a green matrix parent whose legs carry 1 + 2 → group 3.
    const greenMatrix: Job[] = [
      job({ jobId: "p1", workflowIdentifier: "build", name: "build" }), // green
      job({ jobId: "gp", workflowIdentifier: "test", name: "test" }), // green matrix parent
      job({ jobId: "l1", workflowIdentifier: "test", name: "test (linux)", matrix: '{"os":"linux"}' }),
      job({ jobId: "l2", workflowIdentifier: "test", name: "test (mac)", matrix: '{"os":"mac"}' }),
    ];
    render(
      <JobList
        jobs={greenMatrix}
        durations={{}}
        warnings={{ p1: 2, l1: 1, l2: 2 }}
        selectedJobId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("3 warnings")).toBeTruthy(); // group total (1 + 2)
    expect(screen.getByText("1")).toBeTruthy(); // the linux leg's per-row count (unique)
  });

  it("does not mark a failed matrix leg, and shows no glyph when counts are absent", () => {
    const failedLeg = job({ jobId: "l1", workflowIdentifier: "test", name: "test (linux)", matrix: '{"os":"linux"}', result: "failed" });
    render(
      <JobList
        jobs={[job({ jobId: "p1", workflowIdentifier: "build", name: "build" }), failedLeg]}
        durations={{}}
        warnings={{ l1: 4 }}
        selectedJobId={null}
        onSelect={vi.fn()}
      />,
    );
    // A failed job never carries the "passed with warnings" glyph.
    expect(screen.queryByLabelText(/warning/)).toBeNull();
  });
});

// ── #114 display aliases ────────────────────────────────────────────────────
describe("JobList aliases (#114)", () => {
  const aliases = { build: "Compile", test: "Matrix suite" };

  it("renders the alias instead of the job name, with the original in a tooltip", () => {
    render(
      <JobList jobs={jobs} durations={durations} aliases={aliases} selectedJobId={null} onSelect={vi.fn()} />,
    );
    // Plain job: alias shown, original gone from the visible label.
    expect(screen.getByText("Compile")).toBeTruthy();
    expect(screen.queryByText("build")).toBeNull();
    // Matrix group header aliased too; legs keep their matrix labels.
    expect(screen.getByText("Matrix suite")).toBeTruthy();
    expect(screen.getByText("os: linux")).toBeTruthy();

    // Hovering reveals the original name — never lost, only layered over.
    fireEvent.mouseEnter(screen.getByText("Compile").parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain("Original: build");
  });

  it("shows a rename pencil per job and group when onRename is wired, reporting key + current alias", () => {
    const onRename = vi.fn();
    render(
      <JobList jobs={jobs} durations={durations} aliases={aliases} selectedJobId={null} onSelect={vi.fn()} onRename={onRename} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename job build" }));
    expect(onRename).toHaveBeenCalledWith({ jobKey: "build", original: "build", alias: "Compile" });
    // The matrix group's pencil hands over the group identity.
    fireEvent.click(screen.getByRole("button", { name: "Rename job test" }));
    expect(onRename).toHaveBeenCalledWith({ jobKey: "test", original: "test", alias: "Matrix suite" });
    // A job without an alias reports alias: null (dialog starts empty).
    fireEvent.click(screen.getByRole("button", { name: "Rename job empty-key" }));
    expect(onRename).toHaveBeenCalledWith({ jobKey: "empty-key", original: "empty-key", alias: null });
  });

  it("renders no pencil when onRename is absent (read-only surfaces stay untouched)", () => {
    render(<JobList jobs={jobs} durations={durations} selectedJobId={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Rename job/ })).toBeNull();
  });
});
