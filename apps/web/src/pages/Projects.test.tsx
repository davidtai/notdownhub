import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Projects } from "./Projects";
import { ThemeProvider } from "../lib/theme";
import { mockFetch } from "../test/helpers";

function renderProjects() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <Projects />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const ALPHA_YAML = [
  "name: CI",
  "on:",
  "  push:",
  '    branches: [main, "release/*"]',
  "  workflow_dispatch:",
  "jobs: {}",
].join("\n");

const BETA_YAML = [
  "name: Test",
  "on:",
  "  pull_request:",
  "    branches:",
  "      - main",
  "      - develop",
  "  schedule:",
  '    - cron: "0 0 * * *"',
  "jobs: {}",
].join("\n");

// acme/alpha: 2 runs of ci.yml (latest id 3); globex/beta: 1 run of test.yml (id 2).
const RUNS = [
  { id: 3, fileName: ".github/workflows/ci.yml", displayName: "CI", eventName: "push", owner: "acme", repo: "alpha", status: "completed", result: "succeeded" },
  { id: 2, fileName: ".github/workflows/test.yml", displayName: "Test", eventName: "pull_request", owner: "globex", repo: "beta", status: "completed", result: "succeeded" },
  { id: 1, fileName: ".github/workflows/ci.yml", displayName: "CI", eventName: "push", owner: "acme", repo: "alpha", status: "completed", result: "succeeded" },
];

const ATTEMPTS: Record<string, unknown> = {
  "3": [{ id: 3, attempt: 1, workflow: ALPHA_YAML, timeLineId: "tl-3" }],
  "2": [{ id: 2, attempt: 1, workflow: BETA_YAML, timeLineId: "tl-2" }],
};
const JOBS: Record<string, unknown> = {
  "3": [{ jobId: "j3", timeLineId: "job-3", name: "build" }],
  "2": [{ jobId: "j2", timeLineId: "job-2", name: "unit" }],
};
const TIMELINES: Record<string, unknown> = {
  "job-3": [{ type: "Job", name: "build", startTime: "2020-01-01T00:00:00Z", finishTime: "2020-01-01T00:00:05Z" }],
  "job-2": [{ type: "Job", name: "unit", startTime: "2020-01-01T00:00:00Z", finishTime: "2020-01-01T00:00:05Z" }],
};

/** URL-aware router: attempts/jobs/timelines vary by run id, so match on the path. */
function hubRouter(
  overrides: {
    deleteStatus?: number;
    /** Status returned to the OPTIONS capability probe (bare /api/local/runs). 404 = backend absent. */
    probeStatus?: number;
    runsThrow?: boolean;
    attempts?: Record<string, unknown>;
  } = {},
) {
  const attempts = overrides.attempts ?? ATTEMPTS;
  return (url: string) => {
    if (url.includes("/api/local/runs")) {
      // The DELETE carries ?project=…; the bare path is the OPTIONS capability probe.
      if (url.includes("project=")) return { status: overrides.deleteStatus ?? 200 };
      return { status: overrides.probeStatus ?? 204 }; // backend present by default
    }
    if (url.includes("/workflow/runs")) return overrides.runsThrow ? { throw: true } : { body: RUNS };
    const jobs = url.match(/run\/(\d+)\/attempt\/\d+\/jobs/);
    if (jobs) return { body: JOBS[jobs[1]] ?? [] };
    const att = url.match(/run\/(\d+)\/attempts/);
    if (att) return { body: attempts[att[1]] ?? [] };
    const tl = url.match(/Timeline\/([\w-]+)/);
    if (tl) return { body: TIMELINES[tl[1]] ?? [] };
    return undefined;
  };
}

afterEach(() => vi.useRealTimers());

describe("Projects", () => {
  it("lists each project with run count, last result, workflows, events and watched branches", async () => {
    mockFetch(hubRouter());
    renderProjects();

    await waitFor(() => expect(screen.getByText("acme/alpha")).toBeTruthy());
    expect(screen.getByText("globex/beta")).toBeTruthy();

    const alpha = screen.getByText("acme/alpha").closest("div")!.parentElement!;
    // 2 runs for acme/alpha (header + the ci.yml workflow row both read "2 runs"), last result Passed.
    expect(within(alpha).getAllByText("2 runs").length).toBeGreaterThan(0);
    expect(within(alpha).getAllByText("Passed").length).toBeGreaterThan(0);
    // Its last-run time is rendered from the job timeline (a real value).
    expect(within(alpha).getByText(/last .* ago/)).toBeTruthy();

    // ci.yml workflow: push branches [main, release/*] + workflow_dispatch.
    expect(screen.getByText("ci.yml")).toBeTruthy();
    expect(screen.getByText("push")).toBeTruthy();
    expect(screen.getByText("workflow_dispatch")).toBeTruthy();
    // "main" is watched by both projects; "release/*" is alpha-only, "develop" beta-only.
    expect(screen.getAllByText("main").length).toBeGreaterThan(0);
    expect(screen.getByText("release/*")).toBeTruthy();
    expect(screen.getByText("develop")).toBeTruthy();

    // test.yml workflow: pull_request + schedule with cron summary.
    expect(screen.getByText("test.yml")).toBeTruthy();
    expect(screen.getByText("pull_request")).toBeTruthy();
    expect(screen.getByText("schedule (0 0 * * *)")).toBeTruthy();
  });

  it("links the workflow file name to a YAML preview that opens in a new tab", async () => {
    mockFetch(hubRouter());
    renderProjects();
    await waitFor(() => expect(screen.getByText("ci.yml")).toBeTruthy());
    const link = screen.getByRole("link", { name: /ci\.yml/ });
    expect(link.getAttribute("href")).toBe("/projects/workflow/3");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("deep-links View runs to the runs list pre-filtered to the project", async () => {
    mockFetch(hubRouter());
    renderProjects();
    await waitFor(() => expect(screen.getByText("acme/alpha")).toBeTruthy());
    const alpha = screen.getByText("acme/alpha").closest("div")!.parentElement!;
    const viewRuns = within(alpha).getByRole("link", { name: "View runs" });
    expect(viewRuns.getAttribute("href")).toBe("/?project=acme%2Falpha");
  });

  it("hides the Remove control until the run-deletion backend (#60) exists", async () => {
    // OPTIONS probe 404s → backend absent → no button that would error when clicked.
    mockFetch(hubRouter({ probeStatus: 404 }));
    renderProjects();
    await waitFor(() => expect(screen.getByText("acme/alpha")).toBeTruthy());
    // Give the capability probe a tick to resolve; the button must never appear.
    await waitFor(() => expect(screen.getByText("globex/beta")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Remove project/ })).toBeNull();
  });

  it("shows the Remove control once the backend is present (probe non-404)", async () => {
    mockFetch(hubRouter({ probeStatus: 204 }));
    renderProjects();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove project acme/alpha" })).toBeTruthy(),
    );
  });

  it("opens a confirm dialog stating exactly what gets deleted, and cancels", async () => {
    mockFetch(hubRouter());
    renderProjects();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove project acme/alpha" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove project acme/alpha" }));
    const dialog = screen.getByRole("dialog", { name: "Remove project acme/alpha" });
    expect(within(dialog).getByText(/permanently deletes all/)).toBeTruthy();
    expect(within(dialog).getByText("2")).toBeTruthy(); // the run count
    expect(within(dialog).getByText(/persisted job logs/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("surfaces the #60-pending message on a defensive 404 from the delete call", async () => {
    // Probe reports present, but the DELETE itself 404s — the operator sees why nothing was removed.
    mockFetch(hubRouter({ deleteStatus: 404 }));
    renderProjects();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove project globex/beta" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove project globex/beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete runs" }));
    await waitFor(() => expect(screen.getByText(/ships with the run-deletion backend/)).toBeTruthy());
    // Dialog stays open so the operator sees why nothing was removed.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows a generic error for a non-404 delete failure", async () => {
    mockFetch(hubRouter({ deleteStatus: 500 }));
    renderProjects();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove project globex/beta" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove project globex/beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete runs" }));
    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeTruthy());
  });

  it("closes the dialog and refreshes when the delete succeeds", async () => {
    mockFetch(hubRouter({ deleteStatus: 200 }));
    renderProjects();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove project globex/beta" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove project globex/beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete runs" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says so honestly when a workflow definition was not retained", async () => {
    // acme/alpha's latest run (id 3) returns no attempts → no YAML.
    mockFetch(hubRouter({ attempts: { "2": ATTEMPTS["2"], "3": [] } }));
    renderProjects();
    await waitFor(() => expect(screen.getByText("acme/alpha")).toBeTruthy());
    expect(screen.getByText(/definition not retained/)).toBeTruthy();
  });

  it("shows 'all branches' and a no-triggers note for definitions without branch filters / on-block", async () => {
    const noBranches = ["name: X", "on: [workflow_dispatch]", "jobs: {}"].join("\n");
    const noOn = ["name: Y", "jobs: {}"].join("\n");
    mockFetch(
      hubRouter({
        attempts: {
          "3": [{ id: 3, attempt: 1, workflow: noBranches, timeLineId: "tl-3" }],
          "2": [{ id: 2, attempt: 1, workflow: noOn, timeLineId: "tl-2" }],
        },
      }),
    );
    renderProjects();
    await waitFor(() => expect(screen.getByText("acme/alpha")).toBeTruthy());
    expect(screen.getByText("all branches")).toBeTruthy();
    expect(screen.getByText(/No triggers declared/)).toBeTruthy();
  });

  it("shows a skeleton first, then the empty state when the hub has no runs", async () => {
    mockFetch((url) => (url.includes("/workflow/runs") ? { body: [] } : undefined));
    const { container } = renderProjects();
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No projects yet")).toBeTruthy());
  });

  it("shows an error state when the hub is unreachable", async () => {
    mockFetch(hubRouter({ runsThrow: true }));
    renderProjects();
    await waitFor(() => expect(screen.getByText(/Couldn't reach the hub/)).toBeTruthy());
  });

  // ── full-history derivation (#90) ──────────────────────────────────────────
  const wf = (latestRunId: number, fileName: string, runCount: number) => ({
    key: `.github/workflows/${fileName}`,
    fileName,
    label: fileName,
    runCount,
    latestRun: { id: latestRunId, fileName: `.github/workflows/${fileName}` },
    latestRunId,
  });
  const summary = (name: string, kind: string, runCount: number, lastRunId: number) => ({
    name,
    kind,
    runCount,
    lastRun: { id: lastRunId, status: "completed", result: "succeeded" },
    lastRunId,
    workflows: [wf(lastRunId, "ci.yml", runCount)],
  });

  it("renders the hub-side FULL-history aggregate — projects absent from the loaded runs page still appear", async () => {
    // /api/local/projects knows 40 acme runs and a whole project (old/legacy)
    // whose runs are nowhere in the 3-run RUNS page fixture.
    mockFetch((url) => {
      if (url.includes("/api/local/projects"))
        return { body: [summary("acme/alpha", "repo", 40, 3), summary("old/legacy", "repo", 37, 99)] };
      return hubRouter()(url);
    });
    renderProjects();
    await waitFor(() => expect(screen.getByText("old/legacy")).toBeTruthy());
    expect(screen.getByText("acme/alpha")).toBeTruthy();
    const legacy = screen.getByText("old/legacy").closest("div")!.parentElement!;
    expect(within(legacy).getAllByText("37 runs").length).toBeGreaterThan(0);
    const alpha = screen.getByText("acme/alpha").closest("div")!.parentElement!;
    expect(within(alpha).getAllByText("40 runs").length).toBeGreaterThan(0);
  });

  it("sections local/unattributed rows under an honest heading with badges — never merged into one project", async () => {
    mockFetch((url) => {
      if (url.includes("/api/local/projects"))
        return {
          body: [
            summary("acme/alpha", "repo", 2, 3),
            summary("local/app", "local", 2, 7),
            summary("local/lib", "local", 1, 8),
            summary("Unknown/Unknown", "unattributed", 5, 9),
          ],
        };
      return hubRouter()(url);
    });
    renderProjects();
    await waitFor(() => expect(screen.getByText("Local & unattributed")).toBeTruthy());
    // Each recorded label stays its own row.
    expect(screen.getByText("local/app")).toBeTruthy();
    expect(screen.getByText("local/lib")).toBeTruthy();
    expect(screen.getByText("Unknown/Unknown")).toBeTruthy();
    expect(screen.getAllByText("local checkout")).toHaveLength(2);
    expect(screen.getByText("unattributed")).toBeTruthy();
    // The honest notes about how these rows were grouped.
    expect(screen.getAllByText(/Grouped by the recorded directory name/).length).toBe(2);
    expect(screen.getByText(/recorded without project attribution/)).toBeTruthy();
    // The repo card carries neither badge nor note.
    const alpha = screen.getByText("acme/alpha").closest("div")!.parentElement!;
    expect(within(alpha).queryByText("local checkout")).toBeNull();
  });

  it("falls back to deriving from the UNPAGED runs list when /api/local/projects is absent (older hub)", async () => {
    // hubRouter has no /api/local/projects route → 404 → client-side derivation.
    const fn = mockFetch(hubRouter());
    renderProjects();
    await waitFor(() => expect(screen.getByText("acme/alpha")).toBeTruthy());
    const runsCalls = fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/workflow/runs"));
    expect(runsCalls.length).toBeGreaterThan(0);
    // Full history: the fallback must never ask for a single page.
    expect(runsCalls.every((u) => !u.includes("page="))).toBe(true);
  });

  // ── #113: planned placeholders + the Add-project wizard + Force run ────────
  const plannedRow = {
    name: "acme/planned",
    kind: "planned",
    runCount: 0,
    lastRun: null,
    lastRunId: null,
    workflows: [],
    planned: {
      workflowFileName: "ci.yml",
      workflowName: "CI",
      events: ["push"],
      branches: ["main"],
      runsOn: ["self-hosted"],
      createdAt: 1,
    },
  };

  /** Router with the merged aggregate (repo + planned), the placeholder CRUD, and agents. */
  function plannedRouter(track: string[] = [], rerunStatus = 200) {
    return (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (url.includes("/api/local/agents")) return { body: [{ id: 1, name: "r1", labels: ["self-hosted"], state: "idle" }] };
      if (url.includes("/api/local/projects/placeholder")) {
        track.push(`${method} ${url}`);
        return { body: { ok: true } };
      }
      if (url.includes("/api/local/projects"))
        return { body: [summary("acme/alpha", "repo", 2, 3), plannedRow] };
      if (url.includes("/rerunworkflow/")) {
        track.push(`${method} ${url}`);
        return rerunStatus === 200 ? { status: 200 } : { status: rerunStatus, body: { error: "source tree is not on the hub" } };
      }
      return hubRouter()(url);
    };
  }

  // mockFetch only passes the URL through; wrap it to see the method too.
  function mockFetchWithMethod(router: (url: string, init?: { method?: string }) => unknown) {
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const r = (router(url, init as { method?: string }) ?? { status: 404, body: {} }) as {
        status?: number;
        body?: unknown;
      };
      const status = r.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: `HTTP ${status}`,
        json: async () => r.body ?? null,
        text: async () => JSON.stringify(r.body ?? null),
        headers: new Headers(),
      } as unknown as Response;
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it("renders a planned placeholder card: badge, no runs yet, parsed facts, dispatch command", async () => {
    mockFetchWithMethod(plannedRouter());
    renderProjects();
    await waitFor(() => expect(screen.getByText("acme/planned")).toBeTruthy());
    const card = screen.getByText("acme/planned").closest("div")!.parentElement!;
    expect(within(card).getByText("planned")).toBeTruthy();
    expect(within(card).getByText("no runs yet")).toBeTruthy();
    expect(within(card).getByText("push")).toBeTruthy();
    expect(within(card).getByText("ci.yml")).toBeTruthy();
    expect(within(card).getByText(/ndh dispatch --server .* --repository acme\/planned/)).toBeTruthy();
    // No runs exist → Force run is disabled, honestly.
    const force = within(card).getByRole("button", { name: "Force run acme/planned" }) as HTMLButtonElement;
    expect(force.disabled).toBe(true);
  });

  it("removes a planned placeholder through the gated CRUD route and refreshes", async () => {
    const calls: string[] = [];
    mockFetchWithMethod(plannedRouter(calls));
    renderProjects();
    await waitFor(() => expect(screen.getByText("acme/planned")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove planned project acme/planned" }));
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith("DELETE") && c.includes("slug=acme%2Fplanned"))).toBe(true),
    );
  });

  it("opens the Add-project wizard from the header button", async () => {
    mockFetchWithMethod(plannedRouter());
    renderProjects();
    await waitFor(() => expect(screen.getByText("acme/alpha")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Add project/ }));
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeTruthy();
    expect(screen.getByText(/Open your workflow YAML/)).toBeTruthy();
  });

  it("Force run fires the #112 replay for the workflow's latest run and navigates to it", async () => {
    const calls: string[] = [];
    mockFetchWithMethod(plannedRouter(calls));
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/projects"]}>
          <Routes>
            <Route path="/projects" element={<Projects />} />
            <Route path="/runs/:id" element={<div>run-detail-page</div>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Force run run 3" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Force run run 3" }));
    await waitFor(() => expect(screen.getByText("run-detail-page")).toBeTruthy());
    expect(calls.some((c) => c === "POST /_apis/v1/Message/rerunworkflow/3")).toBe(true);
  });

  it("Force run surfaces a hub refusal verbatim and does not navigate", async () => {
    mockFetchWithMethod(plannedRouter([], 409));
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/projects"]}>
          <Routes>
            <Route path="/projects" element={<Projects />} />
            <Route path="/runs/:id" element={<div>run-detail-page</div>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Force run run 3" })).toBeTruthy());
    const btn = screen.getByRole("button", { name: "Force run run 3" });
    fireEvent.click(btn);
    // The refusal message becomes the button's tooltip; hovering reveals it.
    fireEvent.mouseEnter(btn.parentElement!);
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toMatch(/source tree is not on the hub/));
    expect(screen.queryByText("run-detail-page")).toBeNull();
  });
});
