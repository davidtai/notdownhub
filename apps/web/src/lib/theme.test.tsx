import { describe, it, expect } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ThemeProvider, useTheme } from "./theme";
import { mql } from "../test/helpers";

const DARK_Q = "(prefers-color-scheme: dark)";

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("system")}>system</button>
    </div>
  );
}

function metaColor(): string | null {
  return document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
    ?.content ?? null;
}

describe("ThemeProvider", () => {
  it("reads the initial theme from localStorage and applies dark", () => {
    localStorage.setItem("ndh-theme", "dark");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(metaColor()).toBe("#0c1014");
    localStorage.clear();
  });

  it("defaults to system and follows the OS preference (light)", () => {
    mql(DARK_Q).matches = false;
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme").textContent).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(metaColor()).toBe("#fbfcfd");
  });

  it("reacts to an OS change only while in system mode, and persists explicit choices", () => {
    mql(DARK_Q).matches = false;
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    // OS flips to dark while in system mode → applied.
    act(() => mql(DARK_Q).emit(true));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // Choose light explicitly → persisted, dark removed, meta updated (existing meta path).
    fireEvent.click(screen.getByText("light"));
    expect(localStorage.getItem("ndh-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(metaColor()).toBe("#fbfcfd");

    // Now OS change must be ignored (not in system mode).
    act(() => mql(DARK_Q).emit(true));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    localStorage.clear();
  });

  it("throws when useTheme is used outside a provider", () => {
    // Silence React's error boundary console noise for the expected throw.
    const spy = () => render(<Probe />);
    expect(spy).toThrow(/within ThemeProvider/);
  });
});
