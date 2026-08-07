import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { FilterInput } from "./FilterInput";

/** Controlled harness mirroring how the pages drive FilterInput. */
function Harness({ onTerms }: { onTerms?: (t: string[]) => void }) {
  const [pills, setPills] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  onTerms?.([...pills, draft]);
  return (
    <FilterInput
      pills={pills}
      onPillsChange={setPills}
      draft={draft}
      onDraftChange={setDraft}
      label="Filter runs"
      placeholder="Search…"
    />
  );
}

const typeIn = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const enter = (el: HTMLElement) => fireEvent.keyDown(el, { key: "Enter", code: "Enter" });

describe("FilterInput", () => {
  it("filters live while typing (draft term) then saves it as a pill on Enter", () => {
    const terms: string[][] = [];
    render(<Harness onTerms={(t) => terms.push(t)} />);
    const input = screen.getByPlaceholderText("Search…") as HTMLInputElement;

    // Typing updates the live draft term (last element of terms).
    typeIn(input, "acme");
    expect(terms.at(-1)).toEqual(["acme"]);

    // Enter commits the query as a pill and clears the live draft.
    enter(input);
    expect(screen.getByText("acme")).toBeTruthy();
    expect(input.value).toBe("");
    expect(terms.at(-1)).toEqual(["acme", ""]); // pill "acme", empty draft
  });

  it("combines multiple pills (AND) and removes one individually", () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText("Search…");
    typeIn(input, "acme");
    enter(input);
    typeIn(screen.getByPlaceholderText("Add filter…"), "ci");
    enter(screen.getByPlaceholderText("Add filter…"));

    expect(screen.getByText("acme")).toBeTruthy();
    expect(screen.getByText("ci")).toBeTruthy();

    // Each pill has its own remove control; removing "acme" leaves "ci".
    const acmePill = screen.getByText("acme").closest("[data-slot='tags-input-item']") as HTMLElement;
    fireEvent.click(within(acmePill).getByRole("button"));
    expect(screen.queryByText("acme")).toBeNull();
    expect(screen.getByText("ci")).toBeTruthy();
  });

  it("rejects blank and duplicate queries", () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText("Search…");

    // Blank Enter adds nothing.
    enter(input);
    expect(screen.queryByRole("button")).toBeNull();

    typeIn(input, "acme");
    enter(input);
    // Duplicate (case-insensitive) is rejected — still a single pill.
    typeIn(screen.getByPlaceholderText("Add filter…"), "ACME");
    enter(screen.getByPlaceholderText("Add filter…"));
    expect(screen.getAllByText(/acme/i)).toHaveLength(1);
  });

  it("clears everything with the Clear control", () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText("Search…");
    typeIn(input, "acme");
    enter(input);
    expect(screen.getByText("acme")).toBeTruthy();

    fireEvent.click(screen.getByText("Clear"));
    expect(screen.queryByText("acme")).toBeNull();
    // Clear disappears once nothing is entered.
    expect(screen.queryByText("Clear")).toBeNull();
  });
});
