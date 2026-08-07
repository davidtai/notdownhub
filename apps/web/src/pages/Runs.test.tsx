import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Runs, AUTO_SEARCH_MAX_PAGES, AUTO_SEARCH_TARGET } from "./Runs";
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

  it("marks a green-but-noisy run in the list once its warnings resolve", async () => {
    // #62: run 1 is green but its timeline carries a warning + a non-fatal error;
    // run 2 is genuinely clean. Only run 1 gets the amber marker.
    const noisy = { id: 1, fileName: "ci.yml", displayName: "Noisy", status: "completed", result: "succeeded" };
    const clean = { id: 2, fileName: "ci.yml", displayName: "Clean", status: "completed", result: "succeeded" };
    mockFetch((url) => {
      if (url.includes("/workflow/runs")) {
        const m = url.match(/page=(\d+)/);
        return { body: (m ? Number(m[1]) : 0) === 0 ? [noisy, clean] : [] };
      }
      if (url.includes("/run/1/attempts")) return { body: [{ id: 1, attempt: 1 }] };
      if (url.includes("/run/2/attempts")) return { body: [{ id: 1, attempt: 1 }] };
      if (url.includes("/run/1/attempt/1/jobs")) return { body: [{ jobId: "a", timeLineId: "tl1" }] };
      if (url.includes("/run/2/attempt/1/jobs")) return { body: [{ jobId: "b", timeLineId: "tl2" }] };
      if (url.includes("/Timeline/tl1"))
        return {
          body: [
            { id: "s1", type: "Task", name: "warn", result: "succeeded", issues: [{ type: "warning", message: "w" }] },
            { id: "s2", type: "Task", name: "soft", result: "succeeded", issues: [{ type: "error", message: "e" }] },
          ],
        };
      if (url.includes("/Timeline/tl2")) return { body: [{ id: "s", type: "Task", name: "ok", result: "succeeded" }] };
      return { status: 404 };
    });
    renderRuns();
    await waitFor(() => expect(screen.getByText("Noisy")).toBeTruthy());
    // Run 1 resolves to 2 warning signals → amber marker; run 2 stays clean.
    await waitFor(() => expect(screen.getByLabelText("2 warnings")).toBeTruthy());
    expect(screen.getAllByLabelText(/warning/)).toHaveLength(1);
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

  // ── #89: a filter searches the FULL history, not just the loaded pages ──────
  const filler = (page: number, n = 30) =>
    Array.from({ length: n }, (_, i) => ({
      id: page * 100 + i + 1,
      fileName: "ci.yml",
      displayName: "CI",
      owner: "acme",
      repo: "widget",
      status: "completed",
      result: "succeeded",
    }));
  const needle = (id: number) => ({
    id,
    fileName: "deploy.yml",
    displayName: "Needle Deploy",
    owner: "legacy",
    repo: "archive",
    status: "completed",
    result: "succeeded",
  });

  it("auto-loads older pages until a term that only matches page 3 surfaces its runs", async () => {
    // The needles live ONLY on page 3 — far past the initially loaded page 0.
    mockFetch(
      pagedRuns({
        0: filler(0),
        1: filler(1),
        2: filler(2),
        3: [needle(900), needle(901), needle(902)],
        4: [],
      }),
    );
    renderRuns();
    await waitFor(() => expect(runLinks()).toHaveLength(30));

    type("needle");
    enter();
    // The bounded auto-search walks pages 1→4 and surfaces the old matches.
    await waitFor(() => expect(runLinks()).toHaveLength(3), { timeout: 10_000 });
    expect(runLinks().map((a) => a.getAttribute("href"))).toEqual([
      "/runs/900",
      "/runs/901",
      "/runs/902",
    ]);
    // History is exhausted (page 4 empty) → the search ended, nothing spins on.
    // In a waitFor: the 3 matches render while page 4 is still in flight (3 < target),
    // so the searching state clears only after that final fetch resolves.
    await waitFor(
      () => expect(screen.queryByText("Searching older runs…")).toBeNull(),
      { timeout: 10_000 },
    );
  });

  it("shows a searching affordance while older pages are being fetched", async () => {
    // Page 2 hangs until released, freezing the search mid-flight so the
    // "Searching older runs…" state is observable deterministically.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spec = pagedRuns({ 0: filler(0), 1: filler(1), 2: [needle(900)], 3: [] });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (/page=2/.test(url)) await gate;
      const r = spec(url) ?? { body: [] };
      return { ok: true, status: 200, statusText: "OK", json: async () => r.body, headers: new Headers() } as unknown as Response;
    }) as unknown as typeof fetch;

    renderRuns();
    await waitFor(() => expect(runLinks()).toHaveLength(30));
    type("needle");
    enter();
    // Stalled on page 2 → zero matches yet, and the UI says it is still looking.
    await waitFor(() => expect(screen.getByText("Searching older runs…")).toBeTruthy());
    expect(screen.queryByText("No runs match these filters.")).toBeNull();

    release();
    await waitFor(() => expect(runLinks()).toHaveLength(1));
    expect(runLinks()[0].getAttribute("href")).toBe("/runs/900");
  });

  it("terminates a zero-match search at the end of history with the empty state", async () => {
    mockFetch(pagedRuns({ 0: filler(0), 1: filler(1), 2: filler(2), 3: [] }));
    renderRuns();
    await waitFor(() => expect(runLinks()).toHaveLength(30));

    type("nonesuch");
    enter();
    // The search drains every page, finds nothing, and settles on the empty state.
    // One waitFor asserts the whole settled state, so a slow final fetch can
    // never race an immediate assertion.
    await waitFor(
      () => {
        expect(screen.getByText("No runs match these filters.")).toBeTruthy();
        expect(screen.queryByText("Searching older runs…")).toBeNull();
        expect(screen.queryByText("Search older runs")).toBeNull();
      },
      { timeout: 10_000 },
    );
  });

  it("pauses at the page bound with a 'Search older runs' control that resumes", async () => {
    // Endless non-matching history: every page below the needle page returns one
    // filler row, so the tranche bound — not the data — must stop the search.
    const needlePage = AUTO_SEARCH_MAX_PAGES + 3;
    mockFetch((url: string) => {
      if (!url.includes("/workflow/runs")) return undefined;
      const p = Number(url.match(/page=(\d+)/)?.[1] ?? 0);
      if (p === needlePage) return { body: [needle(9999)] };
      if (p > needlePage) return { body: [] };
      return { body: filler(p, 1) };
    });
    renderRuns();
    await waitFor(() => expect(runLinks()).toHaveLength(1));

    type("needle");
    enter();
    // Exactly AUTO_SEARCH_MAX_PAGES pages are fetched, then the search pauses.
    await waitFor(() => expect(screen.getByText("Search older runs")).toBeTruthy(), { timeout: 10_000 });
    expect(screen.getByText("No matches in the runs searched so far.")).toBeTruthy();
    expect(screen.getByText(/Searched \d+ runs — 0 matches so far\./)).toBeTruthy();
    expect(runLinks()).toHaveLength(0);

    // Resuming grants a fresh tranche, which reaches the needle page.
    fireEvent.click(screen.getByText("Search older runs"));
    await waitFor(() => expect(runLinks()).toHaveLength(1), { timeout: 10_000 });
    expect(runLinks()[0].getAttribute("href")).toBe("/runs/9999");
  });

  it("keeps infinite scroll working while a filter is active", async () => {
    // Page 0 already satisfies the match target, so the auto-search idles; the
    // sentinel must then extend the search (not stall) when it enters view.
    const page0 = Array.from({ length: AUTO_SEARCH_TARGET }, (_, i) => needle(i + 1));
    mockFetch(
      pagedRuns({
        0: page0,
        1: [needle(500)],
        2: [],
      }),
    );
    renderRuns();
    await waitFor(() => expect(runLinks()).toHaveLength(AUTO_SEARCH_TARGET));

    type("needle");
    enter();
    await waitFor(() => expect(runLinks()).toHaveLength(AUTO_SEARCH_TARGET));

    // Scrolling to the sentinel keeps searching older pages for more matches.
    MockIntersectionObserver.enter();
    await waitFor(() => expect(runLinks()).toHaveLength(AUTO_SEARCH_TARGET + 1), { timeout: 10_000 });
    // Page 2 is empty → end of history → the sentinel retires.
    await waitFor(() => expect(screen.queryByTestId("infinite-sentinel")).toBeNull());
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

// ── #96: real run timestamps, batch-fetched per loaded page ──────────────────
describe("Runs timing enrichment (#96)", () => {
  const FINISHED_META = {
    startedAt: "2020-01-01T00:00:00.000Z",
    finishedAt: "2020-01-01T00:00:04.100Z",
    durationMs: 4100,
  };

  const metaCalls = (fn: ReturnType<typeof mockFetch>) =>
    fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/local/runs-meta"));

  it("enriches the loaded page with ONE batched runs-meta request — no per-row fetches", async () => {
    const done = { id: 1, fileName: "ci.yml", displayName: "CI", status: "completed", result: "succeeded" };
    const live = { id: 2, fileName: "ci.yml", displayName: "Deploy", status: "inProgress", result: null };
    const fn = mockFetch((url) => {
      if (url.includes("/workflow/runs")) {
        const p = Number(url.match(/page=(\d+)/)?.[1] ?? 0);
        return { body: p === 0 ? [done, live] : [] };
      }
      if (url.includes("/api/local/runs-meta"))
        return { body: { 1: FINISHED_META, 2: { startedAt: FINISHED_META.startedAt } } };
      return undefined;
    });
    renderRuns();

    // Finished row: duration line from meta; absolute Started/Finished on hover.
    await waitFor(() => expect(screen.getByText("4.10s")).toBeTruthy());
    const title = screen.getAllByTitle(/Started /)[0].getAttribute("title") ?? "";
    expect(title).toContain(" · Finished ");
    // In-progress row: live "running for …" from its startedAt.
    expect(screen.getByText(/^running for /)).toBeTruthy();

    // Exactly one batched request carried both ids — never one request per row.
    expect(metaCalls(fn)).toEqual(["/api/local/runs-meta?ids=1,2"]);
  });

  it("enriches pages the filter auto-search pulls in (#93 composition)", async () => {
    // The needle lives on page 3; meta exists only for it. The auto-search must
    // surface the run AND its batch enrichment must cover the late page's ids.
    const pageOf = (page: number) =>
      Array.from({ length: 30 }, (_, i) => ({
        id: page * 100 + i + 1,
        fileName: "ci.yml",
        displayName: "CI",
        owner: "acme",
        repo: "widget",
        status: "completed",
        result: "succeeded",
      }));
    const needle900 = {
      id: 900,
      fileName: "deploy.yml",
      displayName: "Needle Deploy",
      owner: "legacy",
      repo: "archive",
      status: "completed",
      result: "succeeded",
    };
    const fn = mockFetch((url) => {
      if (url.includes("/workflow/runs")) {
        const p = Number(url.match(/page=(\d+)/)?.[1] ?? 0);
        const pages: Record<number, unknown[]> = { 0: pageOf(0), 1: pageOf(1), 2: pageOf(2), 3: [needle900], 4: [] };
        return { body: pages[p] ?? [] };
      }
      if (url.includes("/api/local/runs-meta")) return { body: { 900: FINISHED_META } };
      return undefined;
    });
    renderRuns();
    await waitFor(() => expect(runLinks()).toHaveLength(30));

    type("needle");
    enter();
    await waitFor(() => expect(runLinks()).toHaveLength(1), { timeout: 10_000 });

    // The auto-searched page's id was included in a batch, and its row shows real times.
    await waitFor(() => expect(screen.getByText("4.10s")).toBeTruthy(), { timeout: 10_000 });
    expect(metaCalls(fn).some((u) => u.includes("900"))).toBe(true);
  });
});

// ── #132: in-progress rows show their active jobs, aliased ───────────────────
describe("Runs running-jobs enrichment (#132)", () => {
  const LIVE = { id: 5, fileName: "ci.yml", displayName: "CI", owner: "acme", repo: "widget", status: "inProgress", result: null };

  const aliasCalls = (fn: ReturnType<typeof mockFetch>) =>
    fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/local/job-aliases"));

  it("renders the aliased running-jobs line from ONE page-level alias fetch", async () => {
    const fn = mockFetch((url) => {
      if (url.includes("/workflow/runs")) {
        const p = Number(url.match(/page=(\d+)/)?.[1] ?? 0);
        return { body: p === 0 ? [LIVE] : [] };
      }
      if (url.includes("/api/local/runs-meta"))
        return { body: { 5: { startedAt: "2020-01-01T00:00:00.000Z", runningJobs: [{ key: "build", name: "build" }] } } };
      if (url.includes("/api/local/job-aliases"))
        return { body: [{ project: "acme/widget", jobKey: "build", alias: "Compile" }] };
      return undefined;
    });
    renderRuns();

    await waitFor(() => expect(screen.getByText("Compile")).toBeTruthy());
    expect(screen.getByText("running:")).toBeTruthy();
    expect(screen.getByText("Compile").getAttribute("title")).toBe("Original: build");
    // ONE alias fetch covered the whole page — never one per row, and the whole
    // store came back (the endpoint's only filter is a single ?project=).
    expect(aliasCalls(fn)).toEqual(["/api/local/job-aliases"]);
  });

  it("updates the line when the next poll hands over to another job, and drops it on completion", async () => {
    // Mutable backend state: the meta answer changes across polls, like a real
    // run handing over from 'build' to 'test' and then finishing.
    let phase: "build" | "test" | "done" = "build";
    mockFetch((url) => {
      if (url.includes("/workflow/runs")) {
        const p = Number(url.match(/page=(\d+)/)?.[1] ?? 0);
        return { body: p === 0 ? [LIVE] : [] };
      }
      if (url.includes("/api/local/runs-meta")) {
        const meta =
          phase === "build"
            ? { startedAt: "2020-01-01T00:00:00.000Z", runningJobs: [{ key: "build", name: "build" }] }
            : phase === "test"
              ? { startedAt: "2020-01-01T00:00:00.000Z", runningJobs: [{ key: "test", name: "test" }] }
              : { startedAt: "2020-01-01T00:00:00.000Z", finishedAt: "2020-01-01T00:01:00.000Z", durationMs: 60_000 };
        return { body: { 5: meta } };
      }
      if (url.includes("/api/local/job-aliases")) return { body: [] };
      return undefined;
    });
    renderRuns();

    await waitFor(() => expect(screen.getByText("build")).toBeTruthy());

    // Second job takes over → the next poll's batch answer replaces the line.
    phase = "test";
    await waitFor(() => expect(screen.getByText("test")).toBeTruthy(), { timeout: 10_000 });
    expect(screen.queryByText("build")).toBeNull();

    // Run finishes → runningJobs disappears from the meta and the line goes with
    // it (never stale-forever), replaced by the finished-run duration.
    phase = "done";
    await waitFor(() => expect(screen.queryByText(/running:/)).toBeNull(), { timeout: 10_000 });
    expect(screen.queryByText("test")).toBeNull();
  }, 30_000); // three real poll cycles (2.5s apart) drive the hand-over
});
