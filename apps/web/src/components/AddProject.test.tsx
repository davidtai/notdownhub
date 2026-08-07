import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddProject, isValidSlug } from "./AddProject";
import { mockFetch } from "../test/helpers";

const YAML = [
  "name: CI",
  "# repo: https://github.com/acme/app",
  "on:",
  "  push:",
  "    branches: [main]",
  "jobs:",
  "  build:",
  "    runs-on: [self-hosted, gpu]",
  "    steps: [{ run: 'true' }]",
].join("\n");

const AGENTS = [{ id: 1, name: "r1", labels: ["self-hosted", "linux"], online: true, busy: false, state: "idle" }];

function file(contents: string, name = "ci.yml"): File {
  return new File([contents], name, { type: "text/yaml" });
}

function renderWizard(overrides: { createStatus?: number; agents?: unknown } = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const fetchMock = mockFetch((url) => {
    if (url.includes("/api/local/agents")) return { body: overrides.agents ?? AGENTS };
    if (url.includes("/api/local/projects/placeholder"))
      return { status: overrides.createStatus ?? 200, body: { ok: true } };
    return undefined;
  });
  render(<AddProject onClose={onClose} onCreated={onCreated} />);
  return { onClose, onCreated, fetchMock };
}

/** Drive the mandatory first step: provide a workflow file through the picker. */
async function openFile(contents = YAML) {
  fireEvent.change(screen.getByLabelText("Workflow YAML file"), { target: { files: [file(contents)] } });
  await waitFor(() => expect(screen.getByText(/Runs on/i)).toBeTruthy());
}

describe("AddProject wizard", () => {
  it("step 1 is mandatory by construction: no forward control exists until a file parses", () => {
    renderWizard();
    expect(screen.getByText(/Open your workflow YAML/)).toBeTruthy();
    expect(screen.getByText(/This step is required/)).toBeTruthy();
    // No Continue/Create anywhere on step 1 — only Cancel.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("rejects a file that is not a runnable workflow and stays on the file step", async () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText("Workflow YAML file"), {
      target: { files: [file("name: X\n# no jobs")] },
    });
    await waitFor(() => expect(screen.getByText(/declares no jobs/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.getByText(/Open your workflow YAML/)).toBeTruthy();
  });

  it("accepts a dropped file too (drag-and-drop)", async () => {
    renderWizard();
    fireEvent.drop(screen.getByTestId("workflow-dropzone"), { dataTransfer: { files: [file(YAML)] } });
    await waitFor(() => expect(screen.getByText(/Runs on/i)).toBeTruthy());
  });

  it("review step shows the parsed name, events, branches, and runs-on checked against the live fleet", async () => {
    renderWizard();
    await openFile();
    expect(screen.getByText(/CI/)).toBeTruthy();
    expect(screen.getByText(/1 job/)).toBeTruthy();
    expect(screen.getByText("push")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    // self-hosted is on the fleet; gpu is not → honest warning.
    await waitFor(() => expect(screen.getByText("matched by the current fleet")).toBeTruthy());
    expect(screen.getByText("no runner matches")).toBeTruthy();
    expect(screen.getByText(/No runner in the current fleet matches 'gpu'/)).toBeTruthy();
  });

  it("annotates hosted and dynamic labels instead of warning about them", async () => {
    renderWizard();
    await openFile(
      ["on: push", "jobs:", "  a:", "    runs-on: ubuntu-latest", "  b:", "    runs-on: ${{ matrix.os }}"].join("\n"),
    );
    await waitFor(() => expect(screen.getByText(/hosted label/)).toBeTruthy());
    expect(screen.getByText(/resolved at run time/)).toBeTruthy();
    // Neither is a miss — no warning banner.
    expect(screen.queryByText(/No runner in the current fleet matches/)).toBeNull();
  });

  it("prefills the slug from a github.com hint in the YAML and validates owner/repo", async () => {
    renderWizard();
    await openFile();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const input = screen.getByLabelText("Project slug (owner/repo)") as HTMLInputElement;
    expect(input.value).toBe("acme/app"); // from the github.com/acme/app comment
    fireEvent.change(input, { target: { value: "not-a-slug" } });
    expect(screen.getByText(/two parts: owner\/repo/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Create project/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates the placeholder with the parsed facts and hands over tailored setup commands", async () => {
    const { onCreated, fetchMock } = renderWizard();
    await openFile();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.getByText(/registered as planned/)).toBeTruthy());
    expect(onCreated).toHaveBeenCalled();

    // The POST body carries exactly what was parsed from the file.
    const post = fetchMock.mock.calls.find((c) => String(c[0]).includes("placeholder"))!;
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body.slug).toBe("acme/app");
    expect(body.workflowName).toBe("CI");
    expect(body.workflowFileName).toBe("ci.yml");
    expect(body.events).toEqual(["push"]);
    expect(body.branches).toEqual(["main"]);
    expect(body.runsOn).toEqual(["self-hosted", "gpu"]);

    // Tailored to the slug: dispatch + hook install lines.
    expect(screen.getByText(/ndh dispatch --server .* --repository acme\/app/)).toBeTruthy();
    expect(screen.getByText(/ndh hook install \/srv\/git\/app\.git/)).toBeTruthy();

    // The copy affordance works (clipboard is mocked in setup).
    fireEvent.click(screen.getByRole("button", { name: /Copy: Dispatch/ }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  });

  it("surfaces a create failure honestly and stays on the slug step", async () => {
    renderWizard({ createStatus: 500 });
    await openFile();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Create project/ })).toBeTruthy();
  });

  it("Back returns to the previous step; Cancel closes the wizard", async () => {
    const { onClose } = renderWizard();
    await openFile();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" })); // slug → review
    expect(screen.getByText(/Runs on/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" })); // review → file
    expect(screen.getByText(/Open your workflow YAML/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("isValidSlug", () => {
  it("accepts owner/repo only", () => {
    expect(isValidSlug("acme/app")).toBe(true);
    expect(isValidSlug("acme")).toBe(false);
    expect(isValidSlug("a/b/c")).toBe(false);
    expect(isValidSlug("a b/c")).toBe(false);
    expect(isValidSlug("/x")).toBe(false);
  });
});
