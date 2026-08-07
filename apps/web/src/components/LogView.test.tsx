import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LogGroups } from "./LogView";

describe("LogGroups", () => {
  it("renders nothing for an empty log", () => {
    const { container } = render(<LogGroups lines={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders flat lines, substituting a space for a blank line", () => {
    const { container } = render(<LogGroups lines={["hello", ""]} className="cls" />);
    const pres = container.querySelectorAll("pre");
    expect(pres[0].textContent).toBe("hello");
    expect(pres[1].textContent).toBe(" ");
    expect(container.firstElementChild?.className).toContain("cls");
  });

  it("collapses a completed group by default and toggles open/closed on click", () => {
    // The group is completed (has its ##[endgroup]) → collapsed by default, GitHub-style.
    render(<LogGroups lines={["##[group]Setup", "a", "b", "##[endgroup]", "tail"]} />);
    const toggle = screen.getByRole("button", { name: /Setup/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false"); // completed → collapsed
    expect(screen.getByText("2")).toBeTruthy(); // leaf count
    expect(screen.getByText("a")).toBeTruthy(); // still in the DOM (collapse is CSS-only)
    expect(screen.getByText("tail")).toBeTruthy();

    fireEvent.click(toggle); // user override opens it…
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle); // …and closes it again
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a still-streaming group (no endgroup yet) expanded by default", () => {
    render(<LogGroups lines={["##[group]Live", "a", "b"]} />);
    const toggle = screen.getByRole("button", { name: /Live/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true"); // unterminated → open
    fireEvent.click(toggle); // user can still collapse it
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("nests groups with increasing indent depth", () => {
    render(
      <LogGroups
        lines={["##[group]Outer", "x", "##[group]Inner", "y", "##[endgroup]", "##[endgroup]"]}
      />,
    );
    expect(screen.getByRole("button", { name: /Outer/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Inner/ })).toBeTruthy();
    expect(screen.getByText("y")).toBeTruthy();
  });
});
