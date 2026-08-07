import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddRunner } from "./AddRunner";
import { mockFetch, routes } from "../test/helpers";

function cmd(): string {
  return document.querySelector("pre")?.textContent ?? "";
}

describe("AddRunner", () => {
  it("shows a live token and --token flag for an authorized hub", async () => {
    mockFetch(routes({ "/api/local/join-info": { host: "hub.local", port: 4949, token: "SECRET", authEnabled: true } }));
    render(<AddRunner />);
    await waitFor(() => expect(screen.getByText(/Live token for this hub/)).toBeTruthy());
    expect(cmd()).toContain("ndh runner join http://hub.local:4949");
    expect(cmd()).toContain("--token SECRET");
  });

  it("says open registration when the hub runs with --no-auth", async () => {
    mockFetch(routes({ "/api/local/join-info": { host: "h", port: 4949, token: null, authEnabled: false } }));
    render(<AddRunner />);
    await waitFor(() => expect(screen.getByText(/Open registration/)).toBeTruthy());
    expect(cmd()).not.toContain("--token");
  });

  it("explains local-only mode on a 403 and shows a placeholder token", async () => {
    mockFetch(routes({ "/api/local/join-info": { status: 403 } }));
    render(<AddRunner />);
    await waitFor(() => expect(screen.getByText(/UI is local-only/)).toBeTruthy());
    // Placeholder token routed through the highlighter (its <token> branch).
    expect(cmd()).toContain("<token>");
  });

  it("falls back to a generic token hint on other failures", async () => {
    mockFetch(routes({ "/api/local/join-info": { status: 500 } }));
    render(<AddRunner />);
    await waitFor(() => expect(screen.getByText(/stored at/)).toBeTruthy());
  });

  it("switches between CLI and Docker commands", async () => {
    mockFetch(routes({ "/api/local/join-info": { host: "h", port: 4949, token: "T", authEnabled: true } }));
    render(<AddRunner />);
    await waitFor(() => expect(cmd()).toContain("ndh runner join"));
    fireEvent.click(screen.getByText("Docker"));
    expect(cmd()).toContain("docker run -d");
    expect(cmd()).toContain("NDH_HUB_URL=http://h:4949");
    fireEvent.click(screen.getByText("CLI"));
    expect(cmd()).toContain("ndh runner join");
  });

  it("copies via the clipboard API when available", async () => {
    mockFetch(routes({ "/api/local/join-info": { host: "h", port: 4949, token: "T", authEnabled: true } }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<AddRunner />);
    await waitFor(() => expect(cmd()).toContain("ndh runner join"));
    const btn = screen.getByLabelText("Copy command");
    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await waitFor(() => expect(btn.querySelector(".text-success")).toBeTruthy());
  });

  it("falls back to execCommand when the clipboard API rejects", async () => {
    mockFetch(routes({ "/api/local/join-info": { status: 403 } }));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    render(<AddRunner />);
    await waitFor(() => expect(cmd()).toContain("ndh runner join"));
    fireEvent.click(screen.getByLabelText("Copy command"));
    await waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
  });

  it("reports no success when both clipboard and execCommand fail", async () => {
    mockFetch(routes({ "/api/local/join-info": { status: 403 } }));
    // No clipboard at all → straight to the fallback, which then throws.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = vi.fn(() => {
      throw new Error("nope");
    });
    render(<AddRunner />);
    await waitFor(() => expect(cmd()).toContain("ndh runner join"));
    const btn = screen.getByLabelText("Copy command");
    fireEvent.click(btn);
    await waitFor(() => expect(document.execCommand).toHaveBeenCalled());
    expect(btn.querySelector(".text-success")).toBeNull();
  });
});
