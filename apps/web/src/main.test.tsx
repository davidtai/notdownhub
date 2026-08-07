import { describe, it, expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";

// The entry point mounts <App/> into #root; stub App so this only asserts the
// bootstrap wiring, not the whole app tree.
vi.mock("./App", () => ({ default: () => <div data-testid="app">mounted</div> }));

describe("main entry", () => {
  it("creates a root and renders the app", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import("./main");
    await waitFor(() => expect(document.getElementById("root")?.textContent).toContain("mounted"));
  });
});
