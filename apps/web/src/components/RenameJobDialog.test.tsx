import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RenameJobDialog, type RenameTarget } from "./RenameJobDialog";
import { mockFetch } from "../test/helpers";

const target: RenameTarget = { project: "acme/app", jobKey: "build", original: "build", alias: null };

function renderDialog(overrides: { target?: RenameTarget; status?: number } = {}) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const fetchMock = mockFetch((url) => {
    if (url.includes("/api/local/job-aliases")) return { status: overrides.status ?? 200, body: { ok: true } };
    return undefined;
  });
  render(<RenameJobDialog target={overrides.target ?? target} onClose={onClose} onChanged={onChanged} />);
  return { onClose, onChanged, fetchMock };
}

describe("RenameJobDialog (#114)", () => {
  it("states the honest contract: display alias only, original kept on hover", () => {
    renderDialog();
    expect(screen.getByText(/Display alias only/)).toBeTruthy();
    expect(screen.getByText(/stays on hover/)).toBeTruthy();
    // No alias yet → no Clear button, Save disabled until something is typed.
    expect(screen.queryByRole("button", { name: "Clear alias" })).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves a new alias through the gated route and refreshes the caller", async () => {
    const { onClose, onChanged, fetchMock } = renderDialog();
    fireEvent.change(screen.getByLabelText("Job display alias"), { target: { value: "Compile" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
    const post = fetchMock.mock.calls.find((c) => String(c[0]).includes("job-aliases"))! as unknown as [string, RequestInit];
    expect(post[1].method).toBe("POST");
    expect(JSON.parse(post[1].body as string)).toEqual({ project: "acme/app", jobKey: "build", alias: "Compile" });
  });

  it("Enter in the input saves too", async () => {
    const { onClose } = renderDialog();
    fireEvent.change(screen.getByLabelText("Job display alias"), { target: { value: "Compile" } });
    fireEvent.keyDown(screen.getByLabelText("Job display alias"), { key: "Enter" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("clears an existing alias (DELETE) so the original returns", async () => {
    const { onClose, onChanged, fetchMock } = renderDialog({
      target: { ...target, alias: "Compile" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear alias" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
    const del = fetchMock.mock.calls.find((c) => String(c[0]).includes("job-aliases"))! as unknown as [string, RequestInit];
    expect(del[1].method).toBe("DELETE");
    expect(String(del[0])).toContain("project=acme%2Fapp");
    expect(String(del[0])).toContain("jobKey=build");
  });

  it("surfaces a refusal and stays open; Cancel closes without changes", async () => {
    const { onClose, onChanged } = renderDialog({ status: 500 });
    fireEvent.change(screen.getByLabelText("Job display alias"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(/hub refused the alias/)).toBeTruthy());
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces a clear failure honestly", async () => {
    renderDialog({ target: { ...target, alias: "Compile" }, status: 500 });
    fireEvent.click(screen.getByRole("button", { name: "Clear alias" }));
    await waitFor(() => expect(screen.getByText(/Couldn't clear the alias/)).toBeTruthy());
  });
});
