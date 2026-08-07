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

  it("folds a group, shows its leaf count and toggles open/closed", () => {
    render(<LogGroups lines={["##[group]Setup", "a", "b", "##[endgroup]", "tail"]} />);
    const toggle = screen.getByRole("button", { name: /Setup/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true"); // open by default
    expect(screen.getByText("2")).toBeTruthy(); // leaf count
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("tail")).toBeTruthy();

    fireEvent.click(toggle);
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
