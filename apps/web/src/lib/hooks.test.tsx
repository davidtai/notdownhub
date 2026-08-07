import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useMediaQuery, usePoll } from "./hooks";
import { mql } from "../test/helpers";

const Q = "(max-width: 600px)";

describe("useMediaQuery", () => {
  it("reflects the current match and reacts to changes", () => {
    mql(Q).matches = false;
    const { result, unmount } = renderHook(() => useMediaQuery(Q));
    expect(result.current).toBe(false);
    act(() => mql(Q).emit(true));
    expect(result.current).toBe(true);
    unmount(); // exercises removeEventListener
  });

  it("is SSR-safe (server snapshot is false)", () => {
    mql(Q).matches = true;
    function Probe() {
      return <>{String(useMediaQuery(Q))}</>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("false");
  });
});

describe("usePoll", () => {
  it("loads once when the interval is 0", async () => {
    const fn = vi.fn().mockResolvedValue("A");
    const { result } = renderHook(() => usePoll(fn, 0));
    expect(result.current.initial).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe("A");
    expect(result.current.initial).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("captures an error and keeps the last good data", async () => {
    const fn = vi.fn().mockResolvedValueOnce("good").mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePoll(fn, 0));
    await waitFor(() => expect(result.current.data).toBe("good"));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.data).toBe("good"); // last good value stays visible
  });

  it("wraps a non-Error rejection", async () => {
    const fn = vi.fn().mockRejectedValue("plain string");
    const { result } = renderHook(() => usePoll(fn, 0));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.error?.message).toBe("plain string");
  });

  it("polls repeatedly on its interval and stops on unmount", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue("x");
    const { unmount } = renderHook(() => usePoll(fn, 1000));
    await vi.advanceTimersByTimeAsync(0); // first immediate tick
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);
    unmount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(3); // no ticks after unmount
    vi.useRealTimers();
  });

  it("re-runs when a dep changes", async () => {
    const fn = vi.fn().mockResolvedValue("y");
    const { rerender } = renderHook(({ dep }: { dep: number }) => usePoll(fn, 0, [dep]), {
      initialProps: { dep: 1 },
    });
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    rerender({ dep: 2 });
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
  });
});
