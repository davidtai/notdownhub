import { describe, it, expect, afterEach } from "vitest";
import { mql } from "./test/helpers";
import { applyStoredTheme } from "./theme-init";

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("applyStoredTheme (pre-paint theme boot)", () => {
  it("adds the dark class when the stored theme is 'dark'", () => {
    localStorage.setItem("ndh-theme", "dark");
    applyStoredTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("follows the OS in 'system' mode: dark when the media query matches", () => {
    localStorage.setItem("ndh-theme", "system");
    mql("(prefers-color-scheme: dark)").matches = true;
    applyStoredTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("defaults to light when nothing is stored and the OS is light", () => {
    // No stored value → falls back to "system"; matchMedia mock defaults to false.
    applyStoredTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("swallows a storage failure and leaves the class untouched", () => {
    const orig = localStorage.getItem;
    localStorage.getItem = () => {
      throw new Error("storage blocked");
    };
    try {
      expect(() => applyStoredTheme()).not.toThrow();
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    } finally {
      localStorage.getItem = orig;
    }
  });
});
