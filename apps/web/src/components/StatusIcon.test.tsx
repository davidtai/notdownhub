import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusIcon, StatePill, RunnerStateDot, WarningMarker } from "./StatusIcon";
import type { State } from "../lib/format";

const STATES: State[] = ["success", "fail", "running", "queued", "cancelled", "skipped", "unknown"];

describe("StatusIcon", () => {
  it("renders a glyph for every state (with a tooltip wrapper by default)", () => {
    for (const state of STATES) {
      const { unmount } = render(<StatusIcon state={state} />);
      // The tooltip wrapper carries an aria-label = the state's human label.
      expect(screen.getByLabelText(/passed|failed|running|queued|cancelled|skipped|unknown/i)).toBeTruthy();
      unmount();
    }
  });

  it("omits the tooltip wrapper when withTooltip is false", () => {
    const { container } = render(<StatusIcon state="success" withTooltip={false} />);
    expect(container.querySelector("[aria-label]")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

describe("StatePill", () => {
  it("renders the human label for each state", () => {
    for (const state of STATES) {
      const { unmount } = render(<StatePill state={state} />);
      expect(screen.getByText(/passed|failed|running|queued|cancelled|skipped|unknown/i)).toBeTruthy();
      unmount();
    }
  });

  it("reads 'Passed with warnings' + count for a green run carrying warnings", () => {
    render(<StatePill state="success" warnings={3} />);
    expect(screen.getByText("Passed with warnings")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("stays plain 'Passed' when a success run has zero warnings", () => {
    render(<StatePill state="success" warnings={0} />);
    expect(screen.getByText("Passed")).toBeTruthy();
    expect(screen.queryByText("Passed with warnings")).toBeNull();
  });

  it("never shows the warnings variant for a non-success state", () => {
    render(<StatePill state="fail" warnings={5} />);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("Passed with warnings")).toBeNull();
  });
});

describe("WarningMarker", () => {
  it("renders an amber triangle with the count and a pluralized aria-label", () => {
    render(<WarningMarker count={2} />);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByLabelText("2 warnings")).toBeTruthy();
  });

  it("uses the singular label for a single warning", () => {
    render(<WarningMarker count={1} />);
    expect(screen.getByLabelText("1 warning")).toBeTruthy();
  });

  it("omits the tooltip wrapper when asked", () => {
    const { container } = render(<WarningMarker count={1} withTooltip={false} />);
    // aria-label still present on the glyph, but no relative Tooltip wrapper around it.
    expect(screen.getByLabelText("1 warning")).toBeTruthy();
    expect(container.querySelector(".relative")).toBeNull();
  });

  it("renders nothing for a zero or negative count", () => {
    const { container } = render(<WarningMarker count={0} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("RunnerStateDot", () => {
  it("renders active, idle and offline variants", () => {
    const { container: active } = render(<RunnerStateDot state="active" />);
    expect(active.querySelector(".dot-pulse")).toBeTruthy();
    const { container: idle } = render(<RunnerStateDot state="idle" />);
    expect(idle.querySelector(".border-success")).toBeTruthy();
    const { container: offline } = render(<RunnerStateDot state="offline" />);
    expect(offline.querySelector(".border-fg-subtle")).toBeTruthy();
  });
});
