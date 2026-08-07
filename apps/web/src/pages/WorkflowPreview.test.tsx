import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { WorkflowPreview } from "./WorkflowPreview";
import { ThemeProvider } from "../lib/theme";
import { mockFetch } from "../test/helpers";

const YAML = ["name: CI", "on:", "  push:", "    branches: [main]", "jobs: {}"].join("\n");

function renderAt(path: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/projects/workflow/:runId" element={<WorkflowPreview />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("WorkflowPreview", () => {
  it("renders the retained YAML for the run", async () => {
    mockFetch((url) =>
      /run\/7\/attempts/.test(url) ? { body: [{ id: 7, attempt: 1, workflow: YAML, timeLineId: "t" }] } : undefined,
    );
    renderAt("/projects/workflow/7");
    await waitFor(() => expect(screen.getByText(/branches: \[main\]/)).toBeTruthy());
    expect(screen.getByText(/#7/)).toBeTruthy();
  });

  it("says so when no definition was retained for the run", async () => {
    mockFetch((url) => (/run\/9\/attempts/.test(url) ? { body: [] } : undefined));
    renderAt("/projects/workflow/9");
    await waitFor(() =>
      expect(screen.getByText(/No workflow definition was retained/)).toBeTruthy(),
    );
  });
});
