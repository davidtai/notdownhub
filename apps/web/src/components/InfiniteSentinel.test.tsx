import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { InfiniteSentinel } from "./InfiniteSentinel";
import { MockIntersectionObserver } from "../test/helpers";

describe("InfiniteSentinel", () => {
  it("calls onVisible when the sentinel scrolls into view", () => {
    const onVisible = vi.fn();
    render(<InfiniteSentinel onVisible={onVisible} />);
    expect(screen.getByTestId("infinite-sentinel")).toBeTruthy();
    expect(onVisible).not.toHaveBeenCalled();

    MockIntersectionObserver.enter();
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it("renders nothing and never fires when disabled", () => {
    const onVisible = vi.fn();
    render(<InfiniteSentinel onVisible={onVisible} disabled />);
    expect(screen.queryByTestId("infinite-sentinel")).toBeNull();
    MockIntersectionObserver.enter();
    expect(onVisible).not.toHaveBeenCalled();
  });

  it("always calls the latest onVisible callback", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<InfiniteSentinel onVisible={first} />);
    rerender(<InfiniteSentinel onVisible={second} />);
    MockIntersectionObserver.enter();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
