import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  MockEventSource,
  MockIntersectionObserver,
  MockResizeObserver,
  resetMatchMedia,
} from "./helpers";

// jsdom ships no matchMedia, EventSource, ResizeObserver, or clipboard. Install
// controllable stand-ins so the theme engine, log stream, auto-scroll, and copy
// button run under test. Each is reset before every test so cases never leak.

beforeEach(() => {
  resetMatchMedia();
  MockEventSource.reset();
  MockResizeObserver.reset();
  MockIntersectionObserver.reset();
  window.localStorage.clear();

  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;

  // Clipboard: default to a working async writeText; tests may override.
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  // execCommand: jsdom throws "Not implemented"; provide a benign default.
  document.execCommand = vi.fn().mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
