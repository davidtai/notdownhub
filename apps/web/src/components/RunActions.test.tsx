import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { RunActions } from "./RunActions";
import type { WorkflowRun } from "../lib/api";
import { mockFetch, routes } from "../test/helpers";

const running: WorkflowRun = { id: 42, status: "inprogress" };
const done: WorkflowRun = { id: 7, status: "completed", result: "succeeded" };

describe("RunActions", () => {
  it("renders nothing for an unknown-state run", () => {
    const { container } = render(<RunActions run={{ id: 1 }} />);
    expect(container.firstChild).toBeNull();
  });

  it("cancels a running run and calls onDone (labelled, non-compact)", async () => {
    const fn = mockFetch(routes({ "/cancel": { status: 200 } }));
    const onDone = vi.fn();
    render(<RunActions run={running} onDone={onDone} />);
    // Non-compact shows the text label.
    expect(screen.getByText("Cancel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run 42" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fn).toHaveBeenCalledWith("/api/local/runs/42/cancel", { method: "POST" });
  });

  it("prefers onCancelled over onDone when both are given", async () => {
    mockFetch(routes({ "/cancel": { status: 200 } }));
    const onDone = vi.fn();
    const onCancelled = vi.fn();
    render(<RunActions run={running} onDone={onDone} onCancelled={onCancelled} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run 42" }));
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();
  });

  it("shows an inline error when cancel fails", async () => {
    mockFetch(routes({ "/cancel": { status: 500 } }));
    render(<RunActions run={running} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run 42" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/cancel run 42/i);
  });

  it("deletes a finished run behind a confirm dialog (compact, icon-only) and calls onDeleted", async () => {
    const fn = mockFetch(routes({ "/api/local/runs/7": { status: 200, body: { ok: true } } }));
    const onDone = vi.fn();
    const onDeleted = vi.fn();
    render(<RunActions run={done} onDone={onDone} onDeleted={onDeleted} compact />);
    // Compact: icon only, no text label.
    expect(screen.queryByText("Delete")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete run 7" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm delete run" });
    expect(within(dialog).getByText(/persisted job logs/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Delete"));

    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledWith("/api/local/runs/7", { method: "DELETE" });
  });

  it("delete falls back to onDone when onDeleted is absent", async () => {
    mockFetch(routes({ "/api/local/runs/7": { status: 200 } }));
    const onDone = vi.fn();
    render(<RunActions run={done} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete run 7" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Delete"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("shows an error inside the dialog when delete fails, keeping the dialog open", async () => {
    mockFetch(routes({ "/api/local/runs/7": { status: 500 } }));
    render(<RunActions run={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete run 7" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText("Delete"));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy(); // still open
  });

  it("dismisses the confirm dialog without deleting", () => {
    mockFetch(routes({ "/api/local/runs/7": { status: 200 } }));
    render(<RunActions run={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete run 7" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
