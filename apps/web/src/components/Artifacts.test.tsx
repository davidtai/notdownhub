import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Artifacts } from "./Artifacts";
import type { ArtifactSummary } from "../lib/api";

describe("Artifacts", () => {
  it("renders nothing when a run has no artifacts", () => {
    const { container } = render(<Artifacts runId={4} artifacts={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists each artifact with its size and a working download link", () => {
    const artifacts: ArtifactSummary[] = [
      { id: 5, name: "my-artifact", size: 158 },
      { id: 6, name: "coverage report", size: 3 * 1024 * 1024 },
    ];
    render(<Artifacts runId={4} artifacts={artifacts} />);

    expect(screen.getByText("Artifacts")).toBeTruthy();
    expect(screen.getByText("my-artifact")).toBeTruthy();
    expect(screen.getByText("158 B")).toBeTruthy();
    expect(screen.getByText("coverage report")).toBeTruthy();
    expect(screen.getByText("3.0 MB")).toBeTruthy();

    // Each artifact links to its hub-served download (name url-encoded), and asks the browser to save it.
    const first = screen.getByLabelText("Download my-artifact") as HTMLAnchorElement;
    expect(first.getAttribute("href")).toBe("/api/local/artifacts/4/my-artifact");
    expect(first.hasAttribute("download")).toBe(true);
    const second = screen.getByLabelText("Download coverage report") as HTMLAnchorElement;
    expect(second.getAttribute("href")).toBe("/api/local/artifacts/4/coverage%20report");
  });
});
