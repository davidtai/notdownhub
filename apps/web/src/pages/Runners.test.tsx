import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Runners } from "./Runners";
import { ThemeProvider } from "../lib/theme";
import { mockFetch, routes } from "../test/helpers";

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
  { id: 2, name: "runner-b", labels: [], online: false, busy: false, state: "offline" },
  { id: 3, name: "runner-c", os: "Linux 6.1", maxParallelism: 0, labels: ["gpu"], online: true, busy: false, state: "idle" },
];

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
});
