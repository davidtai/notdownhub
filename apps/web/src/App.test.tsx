import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { mockFetch, routes } from "./test/helpers";

describe("App", () => {
  it("mounts the router and renders the Runs surface at /", async () => {
    mockFetch(routes({ "/workflow/runs": [] }));
    render(<App />);
    await waitFor(() => expect(screen.getByText("No runs yet")).toBeTruthy());
    // The app bar (shared chrome) confirms the shell rendered.
    expect(screen.getByLabelText("notdownhub home")).toBeTruthy();
  });
});
