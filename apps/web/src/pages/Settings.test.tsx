import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Settings } from "./Settings";
import { ThemeProvider } from "../lib/theme";
import { mockFetch, routes, type RouteResult } from "../test/helpers";

function renderSettings() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

type Cfg = {
  backend: string;
  secrets: { scope: string; name: string }[];
  vars: { scope: string; name: string; value: string }[];
};

/**
 * Stateful fetch mock: /api/local/config serves `state`, and a hit on a write
 * endpoint applies `onWrite` first — so the poll refresh after a successful
 * mutation observes the post-write world, like the real store would.
 */
function statefulFetch(state: Cfg, onWrite: (url: string) => RouteResult | void) {
  return mockFetch((url) => {
    if (url.includes("/api/local/secrets") || url.includes("/api/local/vars")) {
      return onWrite(url) ?? { body: { ok: true } };
    }
    if (url.includes("/api/local/config")) {
      return { body: { ...state, secrets: [...state.secrets], vars: [...state.vars] } };
    }
    return undefined;
  });
}

describe("Settings", () => {
  it("renders a skeleton, then secrets and variables tables", async () => {
    mockFetch(
      routes({
        "/api/local/config": {
          backend: "keychain",
          secrets: [
            { scope: "global", name: "TOKEN" },
            { scope: "repo:acme/x", name: "DEPLOY_KEY" },
          ],
          vars: [{ scope: "global", name: "NODE_ENV", value: "production" }],
        },
      }),
    );
    const { container } = renderSettings();
    expect(container.querySelector(".animate-pulse")).toBeTruthy();

    await waitFor(() => expect(screen.getByText("TOKEN")).toBeTruthy());
    expect(screen.getByText("keychain")).toBeTruthy(); // backend badge
    expect(screen.getByText("DEPLOY_KEY")).toBeTruthy();
    expect(screen.getByText("repo:acme/x")).toBeTruthy(); // non-global scope passes through
    expect(screen.getByText("NODE_ENV")).toBeTruthy();
    expect(screen.getByText("production")).toBeTruthy(); // variable values are shown
    expect(screen.getAllByText("global").length).toBeGreaterThan(0);
  });

  it("shows empty rows where the form is primary and the CLI hint secondary", async () => {
    mockFetch(routes({ "/api/local/config": { backend: "file", secrets: [], vars: [] } }));
    renderSettings();
    await waitFor(() => expect(screen.getByText(/No secrets stored\./)).toBeTruthy());
    expect(screen.getByText(/No variables stored\./)).toBeTruthy();
    expect(screen.getAllByText(/Add one with the form below/).length).toBe(2);
    // CLI copy is still there, demoted to secondary text.
    expect(screen.getByText("ndh secrets set <NAME>")).toBeTruthy();
    expect(screen.getByText("ndh vars set <NAME> <value>")).toBeTruthy();
    // Both add forms render even when nothing is stored.
    expect(screen.getByRole("button", { name: "Add secret" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add variable" })).toBeTruthy();
  });

  it("shows an error state when the config endpoint fails", async () => {
    mockFetch(routes({ "/api/local/config": { throw: true } }));
    renderSettings();
    await waitFor(() => expect(screen.getByText(/Couldn't load configuration/)).toBeTruthy());
  });

  it("states the dispatching-machine reality near the forms, linking collaboration.md", async () => {
    mockFetch(routes({ "/api/local/config": { backend: "file", secrets: [], vars: [] } }));
    renderSettings();
    await waitFor(() => expect(screen.getByText(/dispatching machine/)).toBeTruthy());
    const link = screen.getByRole("link", { name: "How values reach a run" });
    expect(link.getAttribute("href")).toContain("docs/collaboration.md");
  });

  it("adds a MULTILINE secret exactly as typed and transitions out of the empty state", async () => {
    const state: Cfg = { backend: "file", secrets: [], vars: [] };
    const fn = statefulFetch(state, () => {
      state.secrets.push({ scope: "global", name: "DEPLOY_KEY" });
    });
    renderSettings();
    await waitFor(() => expect(screen.getByText(/No secrets stored\./)).toBeTruthy());

    const value = "-----BEGIN KEY-----\nline2\n-----END KEY-----\n"; // trailing newline typed on purpose
    fireEvent.change(screen.getByLabelText("New secret name"), { target: { value: "DEPLOY_KEY" } });
    fireEvent.change(screen.getByLabelText("New secret value"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));

    // Byte-exact round-trip out of the textarea: the POST body carries the value verbatim.
    await waitFor(() => {
      const post = fn.mock.calls.find(([u, i]) => String(u) === "/api/local/secrets" && (i as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
        name: "DEPLOY_KEY",
        value,
        scope: "global",
      });
    });

    // Empty state gone, the new row listed, and the secret value nowhere in the page.
    await waitFor(() => expect(screen.getByText("DEPLOY_KEY")).toBeTruthy());
    expect(screen.queryByText(/No secrets stored\./)).toBeNull();
    expect(screen.getByText("hidden")).toBeTruthy();
    expect(screen.queryByText(/BEGIN KEY/)).toBeNull();
    // The form cleared for the next entry.
    expect((screen.getByLabelText("New secret name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("New secret value") as HTMLTextAreaElement).value).toBe("");
  });

  it("rejects an invalid name client-side with the CLI's message — no request is sent", async () => {
    const state: Cfg = { backend: "file", secrets: [], vars: [] };
    const fn = statefulFetch(state, () => {});
    renderSettings();
    await waitFor(() => expect(screen.getByText(/No secrets stored\./)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New secret name"), { target: { value: "1BAD" } });
    fireEvent.change(screen.getByLabelText("New secret value"), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    expect(await screen.findByText(/invalid name '1BAD'/)).toBeTruthy();

    // An empty value is refused too.
    fireEvent.change(screen.getByLabelText("New secret name"), { target: { value: "GOOD_NAME" } });
    fireEvent.change(screen.getByLabelText("New secret value"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    expect(await screen.findByText("empty secret value")).toBeTruthy();

    expect(fn.mock.calls.some(([u]) => String(u).includes("/api/local/secrets"))).toBe(false);
  });

  it("surfaces the hub's write error verbatim (e.g. the keychain backend-file hint)", async () => {
    const hint = "keychain write failed: locked — run 'ndh secrets backend file' to use the encrypted-file backend";
    const state: Cfg = { backend: "keychain", secrets: [], vars: [] };
    statefulFetch(state, () => ({ status: 500, body: { ok: false, error: hint } }));
    renderSettings();
    await waitFor(() => expect(screen.getByText(/No secrets stored\./)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New secret name"), { target: { value: "NPM_TOKEN" } });
    fireEvent.change(screen.getByLabelText("New secret value"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    expect(await screen.findByText(new RegExp("run 'ndh secrets backend file'"))).toBeTruthy();
  });

  it("scopes a write to a repository when the scope selector says so", async () => {
    const state: Cfg = { backend: "file", secrets: [], vars: [] };
    const fn = statefulFetch(state, () => {
      state.vars.push({ scope: "acme/x", name: "DEPLOY_TARGET", value: "prod" });
    });
    renderSettings();
    await waitFor(() => expect(screen.getByText(/No variables stored\./)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "DEPLOY_TARGET" } });
    fireEvent.change(screen.getByLabelText("New variable value"), { target: { value: "prod" } });
    fireEvent.change(screen.getByLabelText("New variable scope"), { target: { value: "repo" } });
    // A malformed slug is refused client-side.
    fireEvent.change(screen.getByLabelText("New variable repository (owner/name)"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    expect(await screen.findByText(/owner\/name/)).toBeTruthy();
    expect(fn.mock.calls.some(([u]) => String(u).includes("/api/local/vars"))).toBe(false);

    fireEvent.change(screen.getByLabelText("New variable repository (owner/name)"), { target: { value: "acme/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    await waitFor(() => expect(screen.getByText("DEPLOY_TARGET")).toBeTruthy());
    const post = fn.mock.calls.find(([u, i]) => String(u) === "/api/local/vars" && (i as RequestInit)?.method === "POST");
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      name: "DEPLOY_TARGET",
      value: "prod",
      scope: "acme/x",
    });
    expect(screen.getByText("prod")).toBeTruthy(); // var values stay visible in the table
  });

  it("deletes a secret behind a confirm dialog; cancel sends nothing", async () => {
    const state: Cfg = { backend: "file", secrets: [{ scope: "global", name: "NPM_TOKEN" }], vars: [] };
    const fn = statefulFetch(state, () => {
      state.secrets = [];
    });
    renderSettings();
    await waitFor(() => expect(screen.getByText("NPM_TOKEN")).toBeTruthy());

    // Cancel path: dialog opens, warns, and closes without a request.
    fireEvent.click(screen.getByRole("button", { name: "Delete secret NPM_TOKEN (global)" }));
    let dialog = screen.getByRole("dialog", { name: "Confirm delete secret" });
    expect(within(dialog).getByText(/can't be recovered/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fn.mock.calls.some(([, i]) => (i as RequestInit)?.method === "DELETE")).toBe(false);

    // Confirm path: DELETE with encoded name+scope, then the row disappears on refresh.
    fireEvent.click(screen.getByRole("button", { name: "Delete secret NPM_TOKEN (global)" }));
    dialog = screen.getByRole("dialog", { name: "Confirm delete secret" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("NPM_TOKEN")).toBeNull());
    const del = fn.mock.calls.find(([, i]) => (i as RequestInit)?.method === "DELETE");
    expect(String(del![0])).toBe("/api/local/secrets?name=NPM_TOKEN&scope=global");
    expect(screen.getByText(/No secrets stored\./)).toBeTruthy(); // back to the empty state
  });

  it("keeps the confirm dialog open and shows the message when a secret delete fails", async () => {
    const state: Cfg = { backend: "file", secrets: [{ scope: "global", name: "KEEP" }], vars: [] };
    statefulFetch(state, () => ({ status: 500, body: { ok: false, error: "index write failed" } }));
    renderSettings();
    await waitFor(() => expect(screen.getByText("KEEP")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete secret KEEP (global)" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm delete secret" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByText("index write failed")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("KEEP")).toBeTruthy(); // nothing was removed
  });

  it("deletes a variable directly — no confirm, value visible to the last click", async () => {
    const state: Cfg = {
      backend: "file",
      secrets: [],
      vars: [{ scope: "global", name: "NODE_ENV", value: "production" }],
    };
    const fn = statefulFetch(state, () => {
      state.vars = [];
    });
    renderSettings();
    await waitFor(() => expect(screen.getByText("production")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete variable NODE_ENV (global)" }));
    expect(screen.queryByRole("dialog")).toBeNull(); // vars are not secret: no confirm step
    await waitFor(() => expect(screen.queryByText("NODE_ENV")).toBeNull());
    const del = fn.mock.calls.find(([, i]) => (i as RequestInit)?.method === "DELETE");
    expect(String(del![0])).toBe("/api/local/vars?name=NODE_ENV&scope=global");
  });
});
