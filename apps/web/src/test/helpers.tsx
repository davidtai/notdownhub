import { vi } from "vitest";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement, ReactNode } from "react";

// ── matchMedia ───────────────────────────────────────────────────────────────
// A single cached MediaQueryList per query string so a test can flip `.matches`
// and fire "change" on the very object the component subscribed to.
class MediaQueryListMock {
  media: string;
  matches: boolean;
  private cbs = new Set<() => void>();
  constructor(media: string, matches: boolean) {
    this.media = media;
    this.matches = matches;
  }
  addEventListener(_type: string, cb: () => void) {
    this.cbs.add(cb);
  }
  removeEventListener(_type: string, cb: () => void) {
    this.cbs.delete(cb);
  }
  dispatchEvent() {
    return true;
  }
  emit(matches: boolean) {
    this.matches = matches;
    for (const cb of this.cbs) cb();
  }
}

const mqlCache = new Map<string, MediaQueryListMock>();

export function resetMatchMedia() {
  mqlCache.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      let mql = mqlCache.get(query);
      if (!mql) {
        mql = new MediaQueryListMock(query, false);
        mqlCache.set(query, mql);
      }
      return mql as unknown as MediaQueryList;
    },
  });
}

/** Get (creating if needed) the cached MQL mock for a query, to set/emit changes. */
export function mql(query: string): MediaQueryListMock {
  let m = mqlCache.get(query);
  if (!m) {
    m = new MediaQueryListMock(query, false);
    mqlCache.set(query, m);
  }
  return m;
}

// ── EventSource ──────────────────────────────────────────────────────────────
export class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  private listeners: Record<string, Set<(ev: MessageEvent) => void>> = {};

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    (this.listeners[type] ??= new Set()).add(cb);
  }
  removeEventListener(type: string, cb: (ev: MessageEvent) => void) {
    this.listeners[type]?.delete(cb);
  }
  close() {
    this.closed = true;
  }

  // ── test drivers ──
  open() {
    this.onopen?.();
  }
  error() {
    this.onerror?.();
  }
  emit(type: string, data: unknown) {
    const ev = { data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent;
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  static last(): MockEventSource {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
  static reset() {
    MockEventSource.instances = [];
  }
}

// ── fetch ────────────────────────────────────────────────────────────────────
export interface RouteResult {
  status?: number;
  body?: unknown;
  /** When set, the fetch call rejects (network error) instead of resolving. */
  throw?: boolean;
}

type Router = (url: string) => RouteResult | undefined;

function jsonResponse(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

/**
 * Install a hand-rolled fetch mock. `router(url)` returns a response spec, or
 * undefined for an unmatched URL (served as a 404). No network, no msw.
 */
export function mockFetch(router: Router) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = router(url) ?? { status: 404, body: { error: "unmatched", url } };
    if (r.throw) throw new Error(`network error: ${url}`);
    return jsonResponse(r.status ?? 200, r.body ?? null);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** Convenience: match a set of exact/substring routes to their JSON bodies. */
export function routes(map: Record<string, RouteResult | unknown>): Router {
  return (url: string) => {
    for (const [key, val] of Object.entries(map)) {
      if (url.includes(key)) {
        return isRouteResult(val) ? val : { body: val };
      }
    }
    return undefined;
  };
}

function isRouteResult(v: unknown): v is RouteResult {
  return (
    typeof v === "object" &&
    v !== null &&
    ("status" in v || "body" in v || "throw" in v)
  );
}

// ── render ───────────────────────────────────────────────────────────────────
export function renderWithRouter(
  ui: ReactElement,
  { route = "/", path }: { route?: string; path?: string } = {},
  options?: RenderOptions,
) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  );
  void path;
  return render(ui, { wrapper: Wrapper, ...options });
}
