import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Runs } from "./Runs";
import { ThemeProvider } from "../lib/theme";
import { mockFetch, routes } from "../test/helpers";

function renderRuns() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <Runs />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => vi.useRealTimers());

const CI1 = { id: 1, fileName: "ci.yml", displayName: "CI", status: "completed", result: "succeeded" };
const CI2 = { id: 2, fileName: "ci.yml", displayName: "CI", status: "completed", result: "succeeded" };
const REL = { id: 3, fileName: "release.yml", displayName: "Release", status: "completed", result: "succeeded" };

// Runs across two projects, for the project filter.
const ACME = { id: 10, fileName: "ci.yml", displayName: "CI", owner: "acme", repo: "widget", status: "completed", result: "succeeded" };
const WIDGET2 = { id: 11, fileName: "release.yml", displayName: "Release", owner: "acme", repo: "widget", status: "completed", result: "succeeded" };
const LOCAL = { id: 12, fileName: "ci.yml", displayName: "CI", owner: "local", repo: "scratch", status: "completed", result: "succeeded" };

describe("Runs", () => {
  it("shows a skeleton, then groups runs by workflow and filters via the sidebar", async () => {
    mockFetch(routes({ "/workflow/runs": [CI1, CI2, REL] }));
    const { container } = renderRuns();
    // Initial poll not yet resolved → skeleton rows.
    expect(container.querySelector(".animate-pulse")).toBeTruthy();

    await waitFor(() => expect(screen.getAllByText("CI").length).toBeGreaterThan(0));

    // Sidebar options with counts.
    expect(screen.getByRole("button", { name: /All workflows/ })).toBeTruthy();
    const relButton = screen.getByRole("button", { name: /Release/ });

    // Three run rows initially (two CI links + one Release link).
    expect(screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/runs/"))).toHaveLength(3);

    fireEvent.click(relButton);
    // Only the Release run remains.
    expect(
      screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/runs/")),
    ).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Release/ }).getAttribute("href")).toBe("/runs/3");
  });

  it("filters through the mobile select as well", async () => {
    mockFetch(routes({ "/workflow/runs": [CI1, CI2, REL] }));
    renderRuns();
    await waitFor(() => expect(screen.getByLabelText("Filter by workflow")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Filter by workflow"), { target: { value: "ci.yml" } });
    expect(
      screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/runs/")),
    ).toHaveLength(2);
  });

  it("filters runs by project and composes with the workflow filter", async () => {
    mockFetch(routes({ "/workflow/runs": [ACME, WIDGET2, LOCAL] }));
    renderRuns();
    await waitFor(() => expect(screen.getByRole("group", { name: "Filter by project" })).toBeTruthy());

    const linksNow = () =>
      screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/runs/"));

    // Two projects → a project pill for each plus "All projects"; all three runs shown.
    expect(screen.getByRole("button", { name: /All projects/ })).toBeTruthy();
    expect(linksNow()).toHaveLength(3);

    // Filter to acme/widget → only its two runs remain.
    fireEvent.click(screen.getByRole("button", { name: /acme\/widget/ }));
    expect(linksNow()).toHaveLength(2);

    // Compose with the workflow filter: within acme/widget, keep only Release.
    fireEvent.click(screen.getByRole("button", { name: /Release/ }));
    expect(linksNow()).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Release/ }).getAttribute("href")).toBe("/runs/11");
  });

  it("hides the project filter when every run belongs to one project", async () => {
    mockFetch(routes({ "/workflow/runs": [CI1, CI2, REL] }));
    renderRuns();
    await waitFor(() => expect(screen.getAllByText("CI").length).toBeGreaterThan(0));
    expect(screen.queryByRole("group", { name: "Filter by project" })).toBeNull();
  });

  it("shows the empty state when the hub has no runs", async () => {
    mockFetch(routes({ "/workflow/runs": [] }));
    renderRuns();
    await waitFor(() => expect(screen.getByText("No runs yet")).toBeTruthy());
  });

  it("shows an error state when the hub is unreachable", async () => {
    mockFetch(routes({ "/workflow/runs": { throw: true } }));
    renderRuns();
    await waitFor(() => expect(screen.getByText(/Couldn't reach the hub/)).toBeTruthy());
  });

  it("shows a per-workflow empty message when the selected workflow disappears", async () => {
    vi.useFakeTimers();
    let phase = 1;
    mockFetch((url) => {
      if (url.includes("/workflow/runs")) return { body: phase === 1 ? [CI1, CI2, REL] : [CI1, CI2] };
      return { status: 404 };
    });
    renderRuns();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Select the Release workflow.
    fireEvent.click(screen.getByRole("button", { name: /Release/ }));
    // Next poll drops the Release workflow while the filter stays on it.
    phase = 2;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByText("No runs for this workflow.")).toBeTruthy();
    vi.useRealTimers();
  });
});
