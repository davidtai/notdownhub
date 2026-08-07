import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Settings } from "./Settings";
import { ThemeProvider } from "../lib/theme";
import { mockFetch, routes, type RouteResult } from "../test/helpers";

const SCOPE_KEY = "ndh.filters.settings-scope";

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
 * /api/local/projects serves `projects` (the #91 aggregate the picker reads).
 */
function statefulFetch(
  state: Cfg,
  onWrite: (url: string) => RouteResult | void,
  projects: { name: string }[] | null = null,
) {
  return mockFetch((url) => {
    if (url.includes("/api/local/secrets") || url.includes("/api/local/vars")) {
      return onWrite(url) ?? { body: { ok: true } };
    }
    if (url.includes("/api/local/projects")) {
      return projects === null ? { status: 404, body: null } : { body: projects };
    }
    if (url.includes("/api/local/config")) {
      return { body: { ...state, secrets: [...state.secrets], vars: [...state.vars] } };
    }
    return undefined;
  });
}

describe("Settings", () => {
  it("renders a skeleton, then scope-grouped secrets and variables tables", async () => {
    mockFetch(
      routes({
        "/api/local/config": {
          backend: "keychain",
          secrets: [
            { scope: "global", name: "TOKEN" },
            { scope: "acme/x", name: "DEPLOY_KEY" },
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
    expect(screen.getByText("NODE_ENV")).toBeTruthy();
    expect(screen.getByText("production")).toBeTruthy(); // variable values are shown
    // Scope shows as a group header (not a per-row column now). Both scopes appear.
    expect(screen.getAllByText("global").length).toBeGreaterThan(0);
    expect(screen.getAllByText("acme/x").length).toBeGreaterThan(0);
    // The shared scope filter is present with more than one scope in play.
    expect(screen.getByLabelText("Filter by scope")).toBeTruthy();
  });

  it("hides the scope filter when everything is global (nothing to filter)", async () => {
    mockFetch(
      routes({
        "/api/local/config": {
          backend: "file",
          secrets: [{ scope: "global", name: "TOKEN" }],
          vars: [{ scope: "global", name: "NODE_ENV", value: "prod" }],
        },
      }),
    );
    renderSettings();
    await waitFor(() => expect(screen.getByText("TOKEN")).toBeTruthy());
    expect(screen.queryByLabelText("Filter by scope")).toBeNull();
  });

  it("groups by scope and narrows both lists when a project scope is chosen", async () => {
    mockFetch(
      routes({
        "/api/local/config": {
          backend: "file",
          secrets: [
            { scope: "global", name: "GLOBAL_SECRET" },
            { scope: "acme/x", name: "X_SECRET" },
            { scope: "acme/y", name: "Y_SECRET" },
          ],
          vars: [
            { scope: "global", name: "GLOBAL_VAR", value: "g" },
            { scope: "acme/x", name: "X_VAR", value: "x" },
          ],
        },
      }),
    );
    renderSettings();
    await waitFor(() => expect(screen.getByText("GLOBAL_SECRET")).toBeTruthy());
    // "all" by default → every row shows.
    expect(screen.getByText("X_SECRET")).toBeTruthy();
    expect(screen.getByText("Y_SECRET")).toBeTruthy();
    expect(screen.getByText("X_VAR")).toBeTruthy();

    // Narrow to acme/x: only its rows remain; vars without acme/x show the empty state.
    fireEvent.change(screen.getByLabelText("Filter by scope"), { target: { value: "acme/x" } });
    expect(screen.getByText("X_SECRET")).toBeTruthy();
    expect(screen.queryByText("GLOBAL_SECRET")).toBeNull();
    expect(screen.queryByText("Y_SECRET")).toBeNull();
    expect(screen.getByText("X_VAR")).toBeTruthy();
    expect(screen.queryByText("GLOBAL_VAR")).toBeNull();

    // Narrow to a scope no list has → both lists show the filtered-empty state.
    fireEvent.change(screen.getByLabelText("Filter by scope"), { target: { value: "acme/y" } });
    expect(screen.getByText("Y_SECRET")).toBeTruthy();
    expect(screen.queryByText("X_SECRET")).toBeNull();
    expect(screen.getByText(/No variables scoped to/)).toBeTruthy();

    // Back to all.
    fireEvent.change(screen.getByLabelText("Filter by scope"), { target: { value: "all" } });
    expect(screen.getByText("GLOBAL_SECRET")).toBeTruthy();
    expect(screen.getByText("X_VAR")).toBeTruthy();
  });

  it("persists the scope filter across a remount and writes it to localStorage", async () => {
    const cfg = {
      backend: "file",
      secrets: [
        { scope: "global", name: "GLOBAL_SECRET" },
        { scope: "acme/x", name: "X_SECRET" },
      ],
      vars: [{ scope: "global", name: "GLOBAL_VAR", value: "g" }],
    };
    mockFetch(routes({ "/api/local/config": cfg }));

    const first = renderSettings();
    await waitFor(() => expect(screen.getByText("X_SECRET")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Filter by scope"), { target: { value: "acme/x" } });
    expect(window.localStorage.getItem(SCOPE_KEY)).toBe("acme/x");
    first.unmount();

    // A fresh visit restores the saved filter — only acme/x rows show.
    renderSettings();
    await waitFor(() => expect(screen.getByText("X_SECRET")).toBeTruthy());
    expect((screen.getByLabelText("Filter by scope") as HTMLSelectElement).value).toBe("acme/x");
    expect(screen.queryByText("GLOBAL_SECRET")).toBeNull();
  });

  it("keeps a saved filter on a now-absent scope visible and resettable", async () => {
    window.localStorage.setItem(SCOPE_KEY, "gone/away");
    mockFetch(
      routes({
        "/api/local/config": {
          backend: "file",
          secrets: [{ scope: "global", name: "TOKEN" }],
          vars: [],
        },
      }),
    );
    renderSettings();
    await waitFor(() =>
      expect((screen.getByLabelText("Filter by scope") as HTMLSelectElement).value).toBe("gone/away"),
    );
    // No secret matches the stale scope → filtered-empty state, not the whole list.
    expect(screen.getByText(/No secrets scoped to/)).toBeTruthy();
    expect(screen.queryByText("TOKEN")).toBeNull();
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
    // Nothing to filter → no scope control.
    expect(screen.queryByLabelText("Filter by scope")).toBeNull();
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

  it("scopes a write to a typed repository via the 'Other repository…' fallback", async () => {
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

  it("populates the add-form picker from known projects and posts the picked scope", async () => {
    const state: Cfg = { backend: "file", secrets: [], vars: [] };
    const fn = statefulFetch(
      state,
      () => {
        state.secrets.push({ scope: "acme/web", name: "PICKED" });
      },
      [{ name: "acme/web" }, { name: "acme/api" }, { name: "just-a-name" }],
    );
    renderSettings();
    await waitFor(() => expect(screen.getByText(/No secrets stored\./)).toBeTruthy());

    const select = screen.getByLabelText("New secret scope") as HTMLSelectElement;
    // Known owner/repo projects are offered; a bare label is not.
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "acme/web" })).toBeTruthy(),
    );
    expect(within(select).getByRole("option", { name: "acme/api" })).toBeTruthy();
    expect(within(select).queryByRole("option", { name: "just-a-name" })).toBeNull();

    // Picking a project attaches the value to that scope directly — no free-text needed.
    fireEvent.change(select, { target: { value: "acme/web" } });
    expect(screen.queryByLabelText("New secret repository (owner/name)")).toBeNull();
    fireEvent.change(screen.getByLabelText("New secret name"), { target: { value: "PICKED" } });
    fireEvent.change(screen.getByLabelText("New secret value"), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));

    await waitFor(() => {
      const post = fn.mock.calls.find(
        ([u, i]) => String(u) === "/api/local/secrets" && (i as RequestInit)?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
        name: "PICKED",
        value: "v",
        scope: "acme/web",
      });
    });

    // The refresh (GET /api/local/config) now reports it under the repo scope, NOT global:
    // the new row renders below the acme/web group header, and no global secret was created.
    await waitFor(() => expect(screen.getByText("PICKED")).toBeTruthy());
    expect(screen.getAllByText("acme/web").length).toBeGreaterThan(0);
    expect(screen.queryByText(/No secrets scoped to/)).toBeNull();
    // Nothing landed in a global group — the whole store is the one repo-scoped secret.
    expect(fn.mock.calls.every(([u, i]) => {
      if (String(u) !== "/api/local/secrets" || (i as RequestInit)?.method !== "POST") return true;
      return JSON.parse((i as RequestInit).body as string).scope !== "global";
    })).toBe(true);
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

  it("reports a variable delete failure inline without a confirm dialog", async () => {
    const state: Cfg = {
      backend: "file",
      secrets: [],
      vars: [{ scope: "global", name: "STUCK", value: "v" }],
    };
    statefulFetch(state, () => ({ status: 500, body: { ok: false, error: "index write failed" } }));
    renderSettings();
    await waitFor(() => expect(screen.getByText("STUCK")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete variable STUCK (global)" }));
    expect(await screen.findByText("index write failed")).toBeTruthy();
    expect(screen.getByText("STUCK")).toBeTruthy(); // nothing removed
  });
});
