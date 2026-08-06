# notdownhub architecture

notdownhub is a small TypeScript CLI (`ndh`) that orchestrates a pinned bundle
of [`ChristopherHX/runner.server`](https://github.com/ChristopherHX/runner.server)
v3.14.0. The bundle contains three official-lineage binaries:

- **Runner.Server** — an Actions-protocol server (the "GitHub side": job
  queue, agent pools, workflow parsing, SSE live logs, SQLite persistence).
- **Runner.Client** — a client that submits a local repo's workflows to a
  server and streams results.
- **Runner.Listener** — the official runner agent that registers with a server
  and executes jobs.

Everything `ndh` does is arranging these three, wiring their environment, and
adding one thin Node HTTP front for the hub. There is no re-implemented
workflow engine — that's the whole point.

## Components

```
 ┌──────────────────────────── ndh CLI (packages/cli) ───────────────────────────┐
 │  index.ts   command dispatch (install/run/hub/runner/dispatch/status)          │
 │  vendor.ts  download + pin runner.server v3.14.0 into ~/.notdownhub/vendor     │
 │  runcmd.ts  `run` / `dispatch`  → spawn Runner.Client                          │
 │  hub.ts     `hub up`            → spawn Runner.Server + start front.ts          │
 │  runner.ts  `runner join/start` → configure + run Runner.Listener              │
 │  front.ts   the hub's single-port HTTP front (proxy + mirror + UI + JWT mint)  │
 │  status.ts  `status`           → read agent/run REST APIs                       │
 └────────────────────────────────────────────────────────────────────────────────┘
```

### `ndh run` — one-shot, in-process

`runcmd.ts` invokes `Runner.Client` with the current repo. The Client embeds
its own server + runner, so a single process parses the workflow, schedules
jobs, and runs them locally, then exits. No hub, no ports to expose, no
persistence. `ndh` only injects sensible default `runs-on` mappings
(`-P ubuntu-latest=…`, etc.) unless you pass your own `-P/--platform`; if Docker
is present, `ubuntu-*` images run in `catthehacker/ubuntu:act-latest`,
otherwise on the host.

### `ndh hub up` — persistent coordination server

`hub.ts` spawns `Runner.Server` bound to an **internal** port (default 4950,
`--hub-port`) and starts the Node front (`front.ts`) on the **public** port
(default 4949, `--port`). Only the public port is meant to be reachable; the
front is the single entry point for the UI, the REST/Actions API, the runner
protocol, and the action mirror.

### `ndh runner join` / `ndh runner start` — fleet members

`runner.ts` copies the vendor bundle into a per-runner directory under
`~/.notdownhub/runners/<name>/bin` (the listener writes `.runner` and
`.credentials` next to its binary, so each instance needs its own root). `join`
runs `Runner.Listener configure --unattended` against `<hub-url>/runner/server`;
`start` runs `Runner.Listener run`. The listener long-polls the server
**outbound only**, so runners work behind NAT with no inbound ports.

## The hub front (`front.ts`)

The front is ~150 lines of Node `http` and does four things on the one public
port:

```
  request to :4949
      │
      ├─ /mirror/<owner>/<repo>/(tarball|zipball)/<ref>
      │      → serve cached archive, else fetch from api.github.com and cache
      │
      ├─ /ui, /assets, static files (not /_apis, /runner, /api)
      │      → serve the web SPA from ui-dist (SPA fallback to index.html)
      │
      └─ everything else
             → reverse-proxy to Runner.Server on 127.0.0.1:4950
               (+ inject a management JWT for anonymous agent-status GETs)
```

### Request flow: registration and the host header

When a runner registers, `Runner.Server` mints **tenant URLs** for that runner
derived from the incoming **`Host` header**. The front therefore proxies the
`Host` header **untouched** — it must stay the public-facing `host:port` the
runner dialed, not the internal `127.0.0.1:4950`. If the host header were
rewritten to the internal address, runners would be handed callback URLs they
can't reach. `ndh runner join` targets `<hub-url>/runner/server`; the
registration token travels as `authorization: RemoteAuth <token>`.

### Request flow: the caching mirror and `ActionDownloadUrls`

To make `uses:` resolvable offline, `hub up` sets (unless
`--no-mirror-rewrite`):

```
Runner.Server__ActionDownloadUrls__0__TarballUrl = http://127.0.0.1:<port>/mirror/{0}/tarball/{1}
Runner.Server__ActionDownloadUrls__0__ZipballUrl = http://127.0.0.1:<port>/mirror/{0}/zipball/{1}
```

`{0}` is `<owner>/<repo>`, `{1}` is the ref. So when a job needs
`actions/checkout@v4`, the server asks the front's `/mirror/...` endpoint
instead of GitHub. The front checks
`~/.notdownhub/mirror/<owner>/<repo>/<kind>-<ref>.tgz`; on a miss it fetches
`https://api.github.com/repos/<owner>/<repo>/<kind>/<ref>`, caches it, and
streams it back. `GITHUB_TOKEN` in the hub's environment is added as
`authorization: token …` to dodge anonymous rate limits. After the first fetch,
that action resolves with the network down.

### Request flow: JWT injection for agent-status reads

`Runner.Server`'s `AgentPools` / `Agent` endpoints require a **management JWT**
even for read-only GETs. So the UI (and `ndh status` when it hits these paths)
would otherwise need a secret to render runner status. The front closes this
gap narrowly: for an **anonymous GET** to `/_apis/v1/Agent…` (no `Authorization`
header already present), it mints a short-lived management JWT by POSTing to
`/api/v3/actions/runner-registration` with the hub's registration token, caches
it (~45 min), and injects it as `Bearer` on the proxied request. Nothing else
gets a token; write paths and non-agent reads pass through as-is.

## The port-443 finding

An **unmodified official `actions/runner`** (not the fork `ndh` bundles) **drops
non-standard ports when it registers.** Point official `Runner.Listener`
v2.336.0 at `http://hub:4949/...` and it strips `:4949`, registering against the
bare host — so the only way an official runner can join an `ndh` hub is on
**`:443` over TLS** (a URL with no explicit port). The bundled fork's listener,
which `ndh runner join` uses, has **no such restriction**, so `ndh`-managed
runners join on any port (4949 by default). Practical upshot: keep using
`ndh runner join` for fleet members; only reach for `:443`+TLS if you must
attach a stock GitHub runner binary.

## Persistence

- **Vendor bundle:** `~/.notdownhub/vendor/runner.server-3.14.0` (downloaded
  once by `ndh install`; the download is cached under `~/.notdownhub/cache`).
- **Hub state:** SQLite at `~/.notdownhub/hub/hub.db`
  (`ConnectionStrings__sqlite`). Without this, `Runner.Server` defaults to an
  in-memory DB that orphans the whole fleet on restart — so `ndh` always sets
  it.
- **Registration token:** `~/.notdownhub/hub/runner-token` (mode `0600`),
  generated once and reused so other machines can keep the same join token
  across hub restarts.
- **Runner identity:** each runner's `.runner` / `.credentials` live in
  `~/.notdownhub/runners/<name>/`.
- **Action mirror cache:** `~/.notdownhub/mirror/<owner>/<repo>/<kind>-<ref>.tgz`.

Override the root with the `NDH_HOME` environment variable.

## Security model (v0.1)

- **Runner registration is token-gated by default.** `hub up` generates a
  random token, prints it, and enforces it via `Runner.Server__RUNNER_TOKEN`.
  `--no-auth` turns this off (open registration).
- **The hub API and UI themselves are unauthenticated.** Anyone who can reach
  port 4949 can read status and drive the API. v0.1 is a **LAN / tailnet tool**
  — do not expose it to the public internet. Registration being token-gated
  only stops unknown machines from *joining as runners*; it does not gate the
  API surface.
- **Management-JWT minting is deliberately scoped.** The front mints a JWT only
  for anonymous read GETs to agent-status endpoints, so displaying runner
  status never requires distributing a secret. It is not a general auth bypass.
- **Trust boundary:** `ndh` assumes every machine that can reach the hub, and
  every runner that has joined, is trusted. Jobs execute real code on runners;
  only dispatch workflows you trust to a fleet you control.
- **One registration = one server.** A runner registration binds to a single
  server URL. The same machine can run an `ndh`-hub runner and a
  github.com-pointed runner concurrently, but they are independent — no job
  crosses between them (issues #5, #6).

## Source map

| File | Responsibility |
|---|---|
| `packages/cli/src/index.ts`  | CLI entry, command dispatch, `--help` / `--version` |
| `packages/cli/src/vendor.ts` | Download + extract the pinned runner.server bundle |
| `packages/cli/src/lib.ts`    | Paths (`NDH_HOME`), download, spawn, tokens |
| `packages/cli/src/runcmd.ts` | `run` / `dispatch` → Runner.Client, default `-P` mappings |
| `packages/cli/src/hub.ts`    | `hub up` → Runner.Server + env wiring + front |
| `packages/cli/src/front.ts`  | Single-port hub HTTP front (proxy / mirror / UI / JWT) |
| `packages/cli/src/runner.ts` | `runner join/start/list` → Runner.Listener |
| `packages/cli/src/status.ts` | `status` → agent + run REST reads |
