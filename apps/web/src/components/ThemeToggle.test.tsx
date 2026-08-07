import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeToggle } from "./ThemeToggle";
import { ThemeProvider } from "../lib/theme";

afterEach(() => localStorage.clear());

describe("ThemeToggle", () => {
  it("offers three options and switches the active one on click", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    const system = screen.getByRole("radio", { name: "System" });
    const dark = screen.getByRole("radio", { name: "Dark" });
    const light = screen.getByRole("radio", { name: "Light" });

    // default is "system" (active branch) with the others inactive.
    expect(system.getAttribute("aria-checked")).toBe("true");
    expect(dark.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(dark);
    expect(dark.getAttribute("aria-checked")).toBe("true");
    expect(system.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("ndh-theme")).toBe("dark");

    fireEvent.click(light);
    expect(light.getAttribute("aria-checked")).toBe("true");
  });
});
