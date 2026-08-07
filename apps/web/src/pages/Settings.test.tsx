import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Settings } from "./Settings";
import { ThemeProvider } from "../lib/theme";
import { mockFetch, routes } from "../test/helpers";

function renderSettings() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("Settings", () => {
  it("renders a skeleton, then secrets and variables tables", async () => {
    mockFetch(
      routes({
        "/api/local/config": {
          backend: "keychain",
          secrets: [
            { scope: "global", name: "TOKEN" },
            { scope: "repo:acme/x", name: "DEPLOY_KEY" },
          ],
          vars: [{ scope: "global", name: "NODE_ENV", value: "production" }],
        },
      }),
    );
    const { container } = renderSettings();
    expect(container.querySelector(".animate-pulse")).toBeTruthy();

    await waitFor(() => expect(screen.getByText("TOKEN")).toBeTruthy());
    expect(screen.getByText("keychain")).toBeTruthy(); // backend badge
    expect(screen.getByText("DEPLOY_KEY")).toBeTruthy();
    expect(screen.getByText("repo:acme/x")).toBeTruthy(); // non-global scope passes through
    expect(screen.getByText("NODE_ENV")).toBeTruthy();
    expect(screen.getByText("production")).toBeTruthy(); // variable values are shown
    expect(screen.getAllByText("global").length).toBeGreaterThan(0);
  });

  it("shows empty rows with CLI hints when nothing is stored", async () => {
    mockFetch(routes({ "/api/local/config": { backend: "file", secrets: [], vars: [] } }));
    renderSettings();
    await waitFor(() => expect(screen.getByText("No secrets stored.")).toBeTruthy());
    expect(screen.getByText("No variables stored.")).toBeTruthy();
    expect(screen.getByText("ndh secrets set <NAME>")).toBeTruthy();
    expect(screen.getByText("ndh vars set <NAME> <value>")).toBeTruthy();
  });

  it("shows an error state when the config endpoint fails", async () => {
    mockFetch(routes({ "/api/local/config": { throw: true } }));
    renderSettings();
    await waitFor(() => expect(screen.getByText(/Couldn't load configuration/)).toBeTruthy());
  });
});
