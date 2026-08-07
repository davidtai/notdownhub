import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Subscribe to a CSS media query (SSR-safe). Used to reorient the pipeline on phones. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export interface Poll<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** true only on the very first load, so the UI can show a skeleton once */
  initial: boolean;
  refresh: () => void;
}

/**
 * Poll an async source on an interval. This is the dashboard's refresh engine:
 * the hub's run/job SSE feed (/_apis/v1/Message/event) proved silent in practice,
 * so we poll on a short interval and keep the last good data visible across
 * refreshes (no flicker). Interval 0 disables auto-refresh (one-shot).
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [initial, setInitial] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const tick = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fnRef.current();
      setData(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
      setInitial(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (!alive) return;
      await tick();
      if (alive && intervalMs > 0) timer = setTimeout(loop, intervalMs);
    };
    setInitial(true);
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  return { data, error, loading, initial, refresh: tick };
}
