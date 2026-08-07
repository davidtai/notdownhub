import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppBar } from "./AppBar";
import { ThemeProvider } from "../lib/theme";

function renderAt(route: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[route]}>
        <AppBar />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("AppBar", () => {
  it("shows the wordmark, all nav links and marks the current route active", () => {
    renderAt("/");
    expect(screen.getByLabelText("notdownhub home")).toBeTruthy();
    for (const label of ["Runs", "Runners", "Settings"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    // At "/", the Runs link is active (renders the underline span); others are not,
    // covering both branches of the isActive render.
    const runs = screen.getByRole("link", { name: "Runs" });
    expect(runs.className).toContain("text-fg");
    expect(runs.querySelector("span.bg-accent")).toBeTruthy();
    const runners = screen.getByRole("link", { name: "Runners" });
    expect(runners.querySelector("span.bg-accent")).toBeNull();
  });

  it("renders the theme control", () => {
    renderAt("/runners");
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeTruthy();
  });
});
