import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Runners } from "./Runners";
import { ThemeProvider } from "../lib/theme";
import { mockFetch, routes, MockIntersectionObserver } from "../test/helpers";

function renderRunners() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <Runners />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const RUNNERS = [
  {
    id: 1,
    poolId: 1,
    name: "runner-a",
    os: "SomeVeryLongDistributionName 12.34.56.78.90 extra words here",
    version: "2.1",
    ephemeral: true,
    maxParallelism: 4,
    labels: ["self-hosted", "linux"],
    online: true,
    busy: true,
    state: "active",
  },
  { id: 2, poolId: 1, name: "runner-b", labels: [], online: false, busy: false, state: "offline" },
  { id: 3, poolId: 1, name: "runner-c", os: "Linux 6.1", maxParallelism: 0, labels: ["gpu"], online: true, busy: false, state: "idle" },
];

const type = (value: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value } });

describe("Runners", () => {
  it("shows a skeleton, then the fleet with state, metadata and an online count", async () => {
    mockFetch(routes({ "/api/local/agents": RUNNERS }));
    const { container } = renderRunners();
    expect(container.querySelector(".animate-pulse")).toBeTruthy();

    await waitFor(() => expect(screen.getByText("runner-a")).toBeTruthy());

    // active + idle count as online → 2/3.
    expect(screen.getByText("2/3 online")).toBeTruthy();

    // State words for each row.
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();

    // Metadata: long OS is truncated with an ellipsis, version, parallelism, ephemeral, labels.
    expect(screen.getByText(/SomeVeryLongDistributionName.*…$/)).toBeTruthy();
    expect(screen.getByText("v2.1")).toBeTruthy();
    expect(screen.getByText("4×")).toBeTruthy();
    expect(screen.getByText("ephemeral")).toBeTruthy();
    expect(screen.getByText("self-hosted")).toBeTruthy();
    expect(screen.getByText("gpu")).toBeTruthy();

    // The AddRunner pairing panel is present.
    expect(screen.getByText("Add a runner")).toBeTruthy();
  });

  it("shows an empty state when no runners are registered", async () => {
    mockFetch(routes({ "/api/local/agents": [] }));
    renderRunners();
    await waitFor(() => expect(screen.getByText("No runners registered")).toBeTruthy());
  });

  it("shows an error state when the runners endpoint fails", async () => {
    // getAgents → getJson throws on a 500; usePoll records the error with no data.
    mockFetch(routes({ "/api/local/agents": { status: 500 } }));
    renderRunners();
    await waitFor(() => expect(screen.getByText(/Couldn't load runners/)).toBeTruthy());
  });

  // ── #58 pill filter + infinite scroll ──────────────────────────────────────

  it("filters runners by name, label and state with combinable pills", async () => {
    mockFetch(routes({ "/api/local/agents": RUNNERS }));
    renderRunners();
    await waitFor(() => expect(screen.getByText("runner-a")).toBeTruthy());

    // Live draft filter by label.
    type("gpu");
    await waitFor(() => expect(screen.getByText("runner-c")).toBeTruthy());
    expect(screen.queryByText("runner-a")).toBeNull();
    expect(screen.queryByText("runner-b")).toBeNull();

    // A term that matches nothing → no-match message.
    type("nonesuch");
    await waitFor(() => expect(screen.getByText("No runners match these filters.")).toBeTruthy());
  });

  it("restores saved runner pills from localStorage", async () => {
    window.localStorage.setItem("ndh.filters.runners", JSON.stringify(["offline"]));
    mockFetch(routes({ "/api/local/agents": RUNNERS }));
    renderRunners();
    // Only the offline runner survives the saved "offline" pill.
    await waitFor(() => expect(screen.getByText("runner-b")).toBeTruthy());
    expect(screen.queryByText("runner-a")).toBeNull();
    expect(screen.getByText("offline")).toBeTruthy(); // the pill
  });

  it("windows the fleet client-side and reveals more as the sentinel enters view", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      poolId: 1,
      name: `runner-${String(i).padStart(2, "0")}`,
      labels: [],
      online: true,
      busy: false,
      state: "idle" as const,
    }));
    mockFetch(routes({ "/api/local/agents": many }));
    renderRunners();

    // First window: 12 of 15 runners.
    await waitFor(() => expect(screen.getByText("runner-00")).toBeTruthy());
    expect(screen.getByText("runner-11")).toBeTruthy();
    expect(screen.queryByText("runner-12")).toBeNull();
    expect(screen.getByTestId("infinite-sentinel")).toBeTruthy();

    // Sentinel enters view → reveal the rest.
    MockIntersectionObserver.enter();
    await waitFor(() => expect(screen.getByText("runner-14")).toBeTruthy());
    expect(screen.queryByTestId("infinite-sentinel")).toBeNull();
  });

  // ── #72 remove runner ───────────────────────────────────────────────────────

  it("opens a confirm dialog whose copy explains hub-unregister vs. machine cleanup", async () => {
    mockFetch(routes({ "/api/local/agents": RUNNERS }));
    renderRunners();
    await waitFor(() => expect(screen.getByText("runner-a")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Remove runner-a"));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    // States: unregisters from the hub, immediate, and points at the CLI for the machine side.
    expect(screen.getByText(/disappears from the list right away/)).toBeTruthy();
    expect(screen.getByText(/won't reappear here on its own/)).toBeTruthy();
    expect(screen.getByText(/ndh runner remove runner-a/)).toBeTruthy();

    // Cancel closes the dialog without any DELETE.
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("removes a runner (DELETE to the agent endpoint) and the row disappears", async () => {
    let removedId: number | null = null;
    const fn = mockFetch((url) => {
      const del = url.match(/\/_apis\/v1\/Agent\/\d+\/(\d+)/);
      if (del) {
        removedId = Number(del[1]);
        return { status: 204 };
      }
      if (url.includes("/api/local/agents")) return { body: RUNNERS.filter((r) => r.id !== removedId) };
      return undefined;
    });
    renderRunners();
    await waitFor(() => expect(screen.getByText("runner-a")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Remove runner-a"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    // The DELETE hits /_apis/v1/Agent/{poolId}/{agentId} with the DELETE method.
    await waitFor(() => expect(fn).toHaveBeenCalledWith("/_apis/v1/Agent/1/1", { method: "DELETE" }));
    // Dialog closes and the row is gone after the immediate refresh.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByText("runner-a")).toBeNull());
    // The rest of the fleet is still listed.
    expect(screen.getByText("runner-b")).toBeTruthy();
  });

  it("keeps the row and surfaces the error when the DELETE fails", async () => {
    mockFetch((url) => {
      if (url.includes("/_apis/v1/Agent/")) return { status: 500 };
      if (url.includes("/api/local/agents")) return { body: RUNNERS };
      return undefined;
    });
    renderRunners();
    await waitFor(() => expect(screen.getByText("runner-c")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Remove runner-c"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    // Error is shown in the still-open dialog.
    await waitFor(() => expect(screen.getByText(/Couldn't remove the runner/)).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Close the dialog — the runner is still in the list (nothing was removed).
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("runner-c")).toBeTruthy();
  });

  it("refuses to unregister a runner the hub reported without a pool id", async () => {
    const noPool = [{ id: 9, name: "poolless", labels: [], online: true, busy: false, state: "idle" }];
    const fn = mockFetch(routes({ "/api/local/agents": noPool }));
    renderRunners();
    await waitFor(() => expect(screen.getByText("poolless")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Remove poolless"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.getByText(/did not report the runner's pool/)).toBeTruthy());
    // No DELETE was attempted.
    expect(fn).not.toHaveBeenCalledWith(expect.stringContaining("/_apis/v1/Agent/"), expect.anything());
  });
});
