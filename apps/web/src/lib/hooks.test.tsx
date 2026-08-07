import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useInfiniteList, useMediaQuery, usePersistentStrings, usePoll } from "./hooks";
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

describe("usePersistentStrings", () => {
  const KEY = "ndh.test.pills";
  afterEach(() => window.localStorage.clear());

  it("reads an existing value from localStorage on mount", () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a", "b"]));
    const { result } = renderHook(() => usePersistentStrings(KEY));
    expect(result.current[0]).toEqual(["a", "b"]);
  });

  it("writes through on update and removes the key when emptied", () => {
    const { result } = renderHook(() => usePersistentStrings(KEY));
    expect(result.current[0]).toEqual([]);

    act(() => result.current[1](["x"]));
    expect(result.current[0]).toEqual(["x"]);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "null")).toEqual(["x"]);

    act(() => result.current[1]([]));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("ignores malformed or non-array stored values", () => {
    window.localStorage.setItem(KEY, "{ not json");
    expect(renderHook(() => usePersistentStrings(KEY)).result.current[0]).toEqual([]);
    window.localStorage.setItem(KEY, JSON.stringify({ nope: 1 }));
    expect(renderHook(() => usePersistentStrings(KEY)).result.current[0]).toEqual([]);
    window.localStorage.setItem(KEY, JSON.stringify(["ok", 5, null]));
    expect(renderHook(() => usePersistentStrings(KEY)).result.current[0]).toEqual(["ok"]);
  });

  it("degrades to in-memory state when storage throws", () => {
    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => usePersistentStrings(KEY));
    act(() => result.current[1](["survives"]));
    expect(result.current[0]).toEqual(["survives"]); // no throw; value kept in memory
    setSpy.mockRestore();
  });

  it("returns [] when reading throws", () => {
    const getSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(renderHook(() => usePersistentStrings(KEY)).result.current[0]).toEqual([]);
    getSpy.mockRestore();
  });
});

describe("useInfiniteList", () => {
  const key = (n: number) => n;

  it("loads the first page, then appends pages via loadMore until empty", async () => {
    const pages: Record<number, number[]> = { 0: [1, 2], 1: [3, 4], 2: [] };
    const load = vi.fn(async (p: number) => pages[p] ?? []);
    const { result } = renderHook(() => useInfiniteList(load, key, 0));

    await waitFor(() => expect(result.current.items).toEqual([1, 2]));
    expect(result.current.initial).toBe(false);
    expect(result.current.hasMore).toBe(true);

    await act(async () => result.current.loadMore());
    expect(result.current.items).toEqual([1, 2, 3, 4]);

    // Next page is empty → end of list.
    await act(async () => result.current.loadMore());
    expect(result.current.hasMore).toBe(false);

    // loadMore is a no-op once exhausted.
    const calls = load.mock.calls.length;
    await act(async () => result.current.loadMore());
    expect(load.mock.calls.length).toBe(calls);
  });

  it("deduplicates items sharing a key across pages", async () => {
    const pages: Record<number, number[]> = { 0: [1, 2], 1: [2, 3] };
    const load = vi.fn(async (p: number) => pages[p] ?? []);
    const { result } = renderHook(() => useInfiniteList(load, key, 0));
    await waitFor(() => expect(result.current.items).toEqual([1, 2]));
    await act(async () => result.current.loadMore());
    expect(result.current.items).toEqual([1, 2, 3]); // the duplicate 2 is dropped
  });

  it("re-fetches the revealed window on its interval to stay live", async () => {
    vi.useFakeTimers();
    let head = [1, 2];
    const load = vi.fn(async (p: number) => (p === 0 ? head : []));
    const { result } = renderHook(() => useInfiniteList(load, key, 1000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.items).toEqual([1, 2]);

    head = [9, 1, 2]; // a new run arrives at the head
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.items).toEqual([9, 1, 2]);
    vi.useRealTimers();
  });

  it("captures errors from a page fetch and wraps non-Errors", async () => {
    const load = vi.fn(async () => {
      throw "nope";
    });
    const { result } = renderHook(() => useInfiniteList(load, key, 0));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.error?.message).toBe("nope");
  });

  it("records an error when loadMore's fetch rejects", async () => {
    let call = 0;
    const load = vi.fn(async () => {
      call += 1;
      if (call === 1) return [1, 2];
      throw new Error("boom");
    });
    const { result } = renderHook(() => useInfiniteList(load, key, 0));
    await waitFor(() => expect(result.current.items).toEqual([1, 2]));
    await act(async () => result.current.loadMore());
    expect(result.current.error?.message).toBe("boom");
  });
});
