import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusIcon, StatePill, RunnerStateDot } from "./StatusIcon";
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
