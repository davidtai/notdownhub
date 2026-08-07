import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  // #125 regression: log text was invisible on live attempt views because the fold
  // container was named `collapse` — Tailwind ships a `collapse` utility
  // (`visibility: collapse`), emits it for any class name found in the source, and
  // every log line inherited it (text hidden, layout preserved). jsdom cannot compute
  // cascaded styles, so this is the strongest honest guard: log lines must carry the
  // text-bearing fg class, and nothing rendered may carry the offending class.
  it("log lines carry text-fg and never render inside a `collapse`-classed element (#125)", () => {
    const { container } = render(<LogGroups lines={["##[group]Live", "streamed line", "plain tail"]} />);
    const pres = [...container.querySelectorAll("pre")];
    expect(pres.length).toBeGreaterThan(0);
    for (const pre of pres) expect(pre.className).toContain("text-fg");
    // The offending combination: any ancestor with the bare `collapse`/`collapse-inner`
    // class picks up Tailwind's visibility utility and hides every line inside it.
    expect(container.querySelector(".collapse")).toBeNull();
    expect(container.querySelector(".collapse-inner")).toBeNull();
    // The renamed fold container wraps the group's lines and is open while streaming.
    const fold = container.querySelector(".fold");
    expect(fold?.getAttribute("data-open")).toBe("true");
    expect(fold?.querySelector(".fold-inner pre")?.textContent).toBe("streamed line");
  });

  // The CSS side of the same guard: the stylesheet must define the fold under the
  // safe name and must not reintroduce a `.collapse` rule (which would silently
  // re-collide with the Tailwind utility of the same name).
  it("index.css defines .fold (not .collapse) for the height-fold trick (#125)", () => {
    // vitest runs with cwd at the package root (apps/web).
    const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
    expect(css).toMatch(/\.fold\s*\{[^}]*grid-template-rows:\s*0fr/);
    expect(css).toMatch(/\.fold\[data-open="true"\]\s*\{[^}]*grid-template-rows:\s*1fr/);
    expect(css).toMatch(/\.fold\s*>\s*\.fold-inner/);
    expect(css).not.toContain(".collapse");
  });
});
