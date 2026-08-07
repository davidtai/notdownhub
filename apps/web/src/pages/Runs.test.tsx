import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Runs } from "./Runs";
import { ThemeProvider } from "../lib/theme";
import { mockFetch } from "../test/helpers";
import { MockIntersectionObserver } from "../test/helpers";

function renderRuns(route = "/") {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[route]}>
        <Runs />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => vi.useRealTimers());

// A page-aware runs router: page 0 unless the URL carries ?page=N.
function pagedRuns(pages: Record<number, unknown[]>) {
  return (url: string) => {
    if (url.includes("/workflow/runs")) {
      const m = url.match(/page=(\d+)/);
      const p = m ? Number(m[1]) : 0;
      return { body: pages[p] ?? [] };
    }
    if (url.includes("throw-here")) return { throw: true };
    return undefined;
  };
}

const runLinks = () =>
  screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/runs/"));

const CI1 = { id: 1, fileName: "ci.yml", displayName: "CI", owner: "acme", repo: "widget", status: "completed", result: "succeeded" };
const REL = { id: 2, fileName: "release.yml", displayName: "Release", owner: "acme", repo: "widget", status: "completed", result: "succeeded" };
const LOCAL = { id: 3, fileName: "ci.yml", displayName: "CI", owner: "local", repo: "scratch", status: "completed", result: "succeeded" };

const type = (value: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value } });
const enter = () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" });

describe("Runs", () => {
  it("shows a skeleton, then the runs list", async () => {
    mockFetch(pagedRuns({ 0: [CI1, REL, LOCAL] }));
    const { container } = renderRuns();
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    await waitFor(() => expect(runLinks()).toHaveLength(3));
  });

  it("filters live while typing and saves the query as a pill on Enter", async () => {
    mockFetch(pagedRuns({ 0: [CI1, REL, LOCAL] }));
    renderRuns();
    await waitFor(() => expect(runLinks()).toHaveLength(3));

    // Live draft filter (before Enter): "local" narrows to the one local/scratch run.
    type("local");
    await waitFor(() => expect(runLinks()).toHaveLength(1));
    expect(runLinks()[0].getAttribute("href")).toBe("/runs/3");

    // Enter saves the query as a pill; the filter stays applied.
    enter();
    expect(screen.getByText("local")).toBeTruthy();
    await waitFor(() => expect(runLinks()).toHaveLength(1));
  });

  it("combines pills with AND", async () => {
    mockFetch(pagedRuns({ 0: [CI1, REL, LOCAL] }));
    renderRuns();
    await waitFor(() => expect(runLinks()).toHaveLength(3));

    type("acme");
    enter();
    await waitFor(() => expect(runLinks()).toHaveLength(2)); // both acme/widget runs

    type("release");
    enter();
    await waitFor(() => expect(runLinks()).toHaveLength(1)); // acme AND release
    expect(runLinks()[0].getAttribute("href")).toBe("/runs/2");
  });

  it("shows a no-match message when filters exclude everything", async () => {
    mockFetch(pagedRuns({ 0: [CI1, REL, LOCAL] }));
    renderRuns();
    await waitFor(() => expect(runLinks()).toHaveLength(3));
    type("nonesuch");
    enter();
    await waitFor(() => expect(screen.getByText("No runs match these filters.")).toBeTruthy());
  });

  it("restores saved pills from localStorage and persists new ones", async () => {
    window.localStorage.setItem("ndh.filters.runs", JSON.stringify(["acme"]));
    mockFetch(pagedRuns({ 0: [CI1, REL, LOCAL] }));
    renderRuns();
    // The saved "acme" pill is applied on mount → only the two acme runs show.
    await waitFor(() => expect(screen.getByText("acme")).toBeTruthy());
    expect(runLinks()).toHaveLength(2);

    // Adding a pill writes through to localStorage.
    type("release");
    enter();
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem("ndh.filters.runs") ?? "[]")).toEqual([
        "acme",
        "release",
      ]),
    );
  });

  it("loads more runs as the scroll sentinel enters view (infinite scroll)", async () => {
    const page0 = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      fileName: "ci.yml",
      displayName: "CI",
      status: "completed",
      result: "succeeded",
    }));
    const page1 = Array.from({ length: 5 }, (_, i) => ({
      id: 100 + i,
      fileName: "ci.yml",
      displayName: "CI",
      status: "completed",
      result: "succeeded",
    }));
    mockFetch(pagedRuns({ 0: page0, 1: page1, 2: [] }));
    renderRuns();
    await waitFor(() => expect(runLinks()).toHaveLength(20));

    // Sentinel visible → load page 1.
    expect(screen.getByTestId("infinite-sentinel")).toBeTruthy();
    MockIntersectionObserver.enter();
    await waitFor(() => expect(runLinks()).toHaveLength(25));

    // Page 2 is empty → end of list, sentinel retires.
    MockIntersectionObserver.enter();
    await waitFor(() => expect(screen.queryByTestId("infinite-sentinel")).toBeNull());
  });

  it("shows the empty state when the hub has no runs", async () => {
    mockFetch(pagedRuns({ 0: [] }));
    renderRuns();
    await waitFor(() => expect(screen.getByText("No runs yet")).toBeTruthy());
  });

  it("shows an error state when the hub is unreachable", async () => {
    mockFetch((url) => (url.includes("/workflow/runs") ? { throw: true } : undefined));
    renderRuns();
    await waitFor(() => expect(screen.getByText(/Couldn't reach the hub/)).toBeTruthy());
  });

  const pillTexts = () =>
    [...document.querySelectorAll("[data-slot='tags-input-item']")].map((e) => (e.textContent ?? "").trim());

  it("folds a ?project= deep link (from the Projects page) into a removable pill", async () => {
    mockFetch(pagedRuns({ 0: [CI1, REL, LOCAL] }));
    renderRuns("/?project=local/scratch");
    // The deep-linked project arrives as a normal, removable pill and pre-filters the list.
    await waitFor(() => expect(pillTexts()).toEqual(["local/scratch"]));
    await waitFor(() => expect(runLinks()).toHaveLength(1));
    expect(runLinks()[0].getAttribute("href")).toBe("/runs/3");
    // It composes with, and is removable like, any other pill.
    const pill = document.querySelector("[data-slot='tags-input-item']") as HTMLElement;
    fireEvent.click(pill.querySelector("button")!);
    await waitFor(() => expect(runLinks()).toHaveLength(3));
    expect(pillTexts()).toEqual([]);
  });

  it("does not duplicate a ?project= pill that is already saved", async () => {
    window.localStorage.setItem("ndh.filters.runs", JSON.stringify(["acme/widget"]));
    mockFetch(pagedRuns({ 0: [CI1, REL, LOCAL] }));
    renderRuns("/?project=acme/widget");
    await waitFor(() => expect(runLinks()).toHaveLength(2));
    // Exactly one "acme/widget" pill — the deep link didn't add a second.
    expect(pillTexts()).toEqual(["acme/widget"]);
  });
});
