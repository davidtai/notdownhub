import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RerunButton } from "./RerunButton";
import { mockFetch } from "../test/helpers";

/** A fetch mock whose response the test resolves by hand, to observe the busy state. */
function deferredFetch() {
  let resolve!: (r: Partial<Response>) => void;
  const gate = new Promise<Partial<Response>>((r) => (resolve = r));
  const calls: { url: string; method?: string }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: { method?: string }) => {
    calls.push({ url: String(input), method: init?.method });
    const r = await gate;
    return { ok: r.ok ?? true, status: r.status ?? 200, statusText: r.statusText ?? "OK" } as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { calls, resolve };
}

describe("RerunButton", () => {
  it("POSTs the hub's native re-run and calls onDone on success", async () => {
    const fn = mockFetch(() => ({ status: 200, body: {} }));
    const onDone = vi.fn();
    render(<RerunButton runId={7} onDone={onDone} />);
    fireEvent.click(screen.getByLabelText("Re-run run 7"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [url, init] = fn.mock.calls[0] as [string, { method?: string }];
    expect(url).toBe("/_apis/v1/Message/rerunworkflow/7");
    expect(init?.method).toBe("POST");
  });

  it("shows a busy state while in flight, then returns to idle", async () => {
    const { resolve } = deferredFetch();
    render(<RerunButton runId={1} />);
    const btn = screen.getByLabelText("Re-run run 1") as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("Re-running…")).toBeTruthy());
    expect(btn.disabled).toBe(true);
    resolve({ ok: true, status: 200 });
    await waitFor(() => expect(screen.getByText("Re-run")).toBeTruthy());
    expect(btn.disabled).toBe(false);
  });

  it("ignores a second click while a re-run is already in flight", async () => {
    const { calls, resolve } = deferredFetch();
    render(<RerunButton runId={2} />);
    const btn = screen.getByLabelText("Re-run run 2");
    fireEvent.click(btn);
    fireEvent.click(btn); // guarded by `busy` — must not fire a second request
    await waitFor(() => expect(screen.getByText("Re-running…")).toBeTruthy());
    expect(calls.length).toBe(1);
    resolve({ ok: true, status: 200 });
    await waitFor(() => expect(screen.getByText("Re-run")).toBeTruthy());
  });

  it("surfaces a failure and does not call onDone", async () => {
    mockFetch(() => ({ status: 502, body: {} }));
    const onDone = vi.fn();
    render(<RerunButton runId={9} onDone={onDone} />);
    const btn = screen.getByLabelText("Re-run run 9");
    fireEvent.click(btn);
    await waitFor(() => expect(btn.className).toMatch(/text-fail/));
    expect(onDone).not.toHaveBeenCalled();
    // The tooltip copy switches to the failure hint on hover.
    fireEvent.mouseEnter(btn.parentElement as HTMLElement);
    expect(screen.getByRole("tooltip").textContent).toMatch(/is the hub reachable/);
  });

  it("shows a hub refusal's honest message verbatim (#110), not the reachability guess", async () => {
    const reason = "this run's source tree is not on the hub — re-dispatch it from the checkout with 'ndh dispatch'";
    mockFetch(() => ({ status: 409, body: { ok: false, error: reason, runId: 14 } }));
    render(<RerunButton runId={14} />);
    const btn = screen.getByLabelText("Re-run run 14");
    fireEvent.click(btn);
    await waitFor(() => expect(btn.className).toMatch(/text-fail/));
    fireEvent.mouseEnter(btn.parentElement as HTMLElement);
    expect(screen.getByRole("tooltip").textContent).toBe(reason);
  });

  it("stops the click from bubbling to a wrapping click handler (no row navigation)", async () => {
    mockFetch(() => ({ status: 200, body: {} }));
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <RerunButton runId={3} />
      </div>,
    );
    fireEvent.click(screen.getByLabelText("Re-run run 3"));
    await waitFor(() => expect(screen.getByText("Re-run")).toBeTruthy());
    expect(parentClick).not.toHaveBeenCalled();
  });
});
