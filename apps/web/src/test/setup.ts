import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { MockEventSource, resetMatchMedia } from "./helpers";

// jsdom ships no matchMedia, EventSource, or clipboard. Install controllable
// stand-ins so the theme engine, log stream, and copy button run under test.
// Each is reset before every test so cases never leak into one another.

beforeEach(() => {
  resetMatchMedia();
  MockEventSource.reset();

  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

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
