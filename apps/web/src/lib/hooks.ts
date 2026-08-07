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

/**
 * A list of strings persisted to localStorage, so an operator's saved filter pills
 * survive reloads and revisits. Reads once on mount; every update writes through
 * (an empty list removes the key). All storage access is guarded — private-mode or
 * quota failures degrade to in-memory state rather than throwing.
 */
export function usePersistentStrings(key: string): [string[], (next: string[]) => void] {
  const [value, setValue] = useState<string[]>(() => readStrings(key));
  const set = useCallback(
    (next: string[]) => {
      setValue(next);
      try {
        if (next.length === 0) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage unavailable — keep the value in memory for this session.
      }
    },
    [key],
  );
  return [value, set];
}

function readStrings(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface InfiniteList<T> {
  /** Every item loaded so far, across all revealed pages (deduplicated by key). */
  items: T[];
  error: Error | null;
  /** true only until the first page resolves, so the UI can show a skeleton once. */
  initial: boolean;
  loadingMore: boolean;
  /** false once a fetched page comes back empty — the end of the list. */
  hasMore: boolean;
  loadMore: () => void;
  /** Re-fetch the revealed window now (e.g. after a mutation) so a change shows immediately. */
  refresh: () => void;
}

/**
 * Windowed, live list loading. `loadPage(n)` returns the rows for page n (an empty
 * array marks the end). The first page loads on mount; `loadMore()` reveals the
 * next one — wire it to a scroll sentinel for infinite scroll. Every `intervalMs`
 * the already-revealed window is re-fetched and rebuilt so the list stays live
 * without losing the user's scroll depth. Interval 0 disables the live refresh.
 */
export function useInfiniteList<T>(
  loadPage: (page: number) => Promise<T[]>,
  keyOf: (item: T) => string | number,
  intervalMs: number,
): InfiniteList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [initial, setInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;

  const pageCountRef = useRef(1); // pages revealed so far
  const hasMoreRef = useRef(true);
  const busyRef = useRef(false);

  const dedup = useCallback((rows: T[]): T[] => {
    const seen = new Set<string | number>();
    const out: T[] = [];
    for (const r of rows) {
      const k = keyOfRef.current(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const collected: T[] = [];
      let end = false;
      for (let p = 0; p < pageCountRef.current; p++) {
        const rows = await loadPageRef.current(p);
        collected.push(...rows);
        if (rows.length === 0) {
          end = true;
          pageCountRef.current = Math.max(1, p);
          break;
        }
      }
      setItems(dedup(collected));
      if (end) {
        hasMoreRef.current = false;
        setHasMore(false);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setInitial(false);
    }
  }, [dedup]);

  const loadMore = useCallback(async () => {
    if (busyRef.current || !hasMoreRef.current) return;
    busyRef.current = true;
    setLoadingMore(true);
    try {
      const next = pageCountRef.current;
      const rows = await loadPageRef.current(next);
      if (rows.length > 0) {
        pageCountRef.current = next + 1;
        setItems((prev) => dedup([...prev, ...rows]));
      } else {
        hasMoreRef.current = false;
        setHasMore(false);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      busyRef.current = false;
      setLoadingMore(false);
    }
  }, [dedup]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (!alive) return;
      await refresh();
      if (alive && intervalMs > 0) timer = setTimeout(loop, intervalMs);
    };
    setInitial(true);
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return { items, error, initial, loadingMore, hasMore, loadMore, refresh };
}
