# notdownhub operations runbook

Day-to-day operation of a notdownhub hub and runner fleet: lifecycle, running
as a service, state & backup, restart semantics, the action mirror,
troubleshooting, and upgrades. For getting `ndh` installed in the first place,
see [install.md](install.md); for how the pieces fit together, see
[architecture.md](architecture.md).

Command output below is real, captured against the current `main` build (a test
hub on ports 5961/5962; your production hub uses 4949/4950).

---

## Hub lifecycle

### Start

```bash
ndh hub up
```

```
[ndh] hub up on http://localhost:4949  (ui: yes, local-only, auth: on, mirror: on @ http://192.168.1.5:4949/mirror)
[ndh] logging to /Users/you/.notdownhub/hub/logs/hub-2026-08-07.log (daily rotation)
[ndh] runner registration token: e599b6b1f4a55af0f0977e0b9d3cd82b98852e615dcd621d
[ndh] join a runner:   ndh runner join http://192.168.1.5:4949 --token e599…
[ndh] dispatch a repo: ndh dispatch --server http://192.168.1.5:4949
```

The hub runs in the foreground and holds the terminal. It is actually **two
processes**: the public Node front, and a `Runner.Server` child bound to the
internal port. The `ui:` field reads `no` (no UI bundled), `yes, local-only`
(bundled, loopback-gated — the default), or `yes, basic-auth` (bundled and
reachable off-box with `--basic-auth`). The `join`/`dispatch` lines use the
resolved `--host`, and everything ndh prints is also written to the daily log.

Useful flags (full list in the [README](../README.md#fleet-quickstart)):

| Flag | Default | Purpose |
|---|---|---|
| `--port <n>` | `4949` | Public port (UI + API + runner protocol + mirror). |
| `--hub-port <n>` | `4950` | Internal `Runner.Server` port, loopback only. |
| `--host <name-or-ip>` | auto (LAN IPv4) | Address baked into mirror URLs handed to runners. See [`--host` selection](#--host-selection-and-why-mirror-urls-depend-on-it). |
| `--basic-auth <user:pass>` | — | Admit **non-local** operators to the UI + `/api/local/join-info` via HTTP Basic. Env: `NDH_BASIC_AUTH`. See [Security model](#security-model-v01). |
| `--no-auth` | off | Disable registration-token auth (open registration). |
| `--github-token <pat>` | — | PAT for the server / mirror rate limits. |
| `--no-mirror-rewrite` | off | Don't route `uses:` through the mirror. |
| `--no-ui` | off | Serve API/protocol only, no static UI. |

### Stop

Ctrl-C (or send `SIGINT`/`SIGTERM` to the `ndh hub up` process). The front
forwards the signal to the `Runner.Server` child and exits. When stopping a
backgrounded/service hub, target the parent `ndh` process — killing only the
child leaves the front proxying to nothing (clients get `502`).

> **Restart gotcha (observed):** the public port is released by the OS a moment
> *after* the process exits. Restarting too eagerly makes the new front fail
> with `EADDRINUSE`, and because the front and `Runner.Server` are separate
> processes the new server child can survive as an orphan on the internal port.
> Wait for the port to free before restarting:
> ```bash
> # stop, then block until the public port is free, then start
> while lsof -nP -iTCP:4949 -sTCP:LISTEN -t >/dev/null 2>&1; do sleep 1; done
> ndh hub up
> ```
> If a stray `Runner.Server` lingers, `kill` the process holding `--hub-port`
> (4950) before restarting. Running as a service (below) sidesteps this by
> supervising a single unit.

### Ports & firewall

- **`4949` (public):** the *only* port that should be reachable by runners,
  developers, and browsers. It carries the UI, REST/Actions API, the runner
  long-poll protocol, and the mirror.
- **`4950` (internal):** `Runner.Server`; the front proxies to it over
  loopback. **Do not expose it.** (`ndh` binds it on `*` so the front can reach
  it, so block it at the firewall.)
- Open `4949/tcp` to your LAN / tailnet only. The hub **API, runner protocol,
  and mirror are unauthenticated** on this port (only runner *registration* is
  token-gated; the UI and pairing endpoint are loopback-gated — see
  [Security model](#security-model-v01)). Never put `4949` on the public
  internet. Prefer a private network / VPN / tailnet. Example (ufw):
  `sudo ufw allow in on tailscale0 to any port 4949`.

### `--host` selection (and why mirror URLs depend on it)

When the mirror rewrite is on (the default), the hub tells each runner to fetch
`uses:` actions from `http://<host>:<port>/mirror/...`. **The runner dials that
URL itself**, so `<host>` must be reachable *from the runner*, not just from the
hub. `ndh` defaults `<host>` to the machine's auto-detected primary LAN IPv4.

Override with `--host` when:

- the auto-detected NIC is wrong (multi-homed hosts, VPNs): `--host 10.0.0.5`;
- you want a stable name instead of an IP: `--host hub.internal`;
- runners reach the hub over a tailnet: `--host hub.tailnet`.

A hub started on an old build (pre-`--host`) baked `127.0.0.1` into these URLs,
which **remote** runners cannot reach — see the mirror troubleshooting row. The
value only affects mirror URLs; the UI/API bind independently.

---

## Security model (v0.1)

The single public port carries surfaces with **different** trust levels. Know
which is which before you open the firewall.

**Loopback-only (the operator at the hub machine):**

- The **web UI** (static SPA) and **`GET /api/local/join-info`** are served only
  to loopback clients (`127.0.0.1` / `::1`). A non-local request is refused:
  `403` when no `--basic-auth` is set (`"the notdownhub UI is local-only; API
  and runner protocol remain available on this port"`), or `401` +
  `WWW-Authenticate: Basic` when it is (below). Verified: loopback → `200`;
  off-box → `403`/`401`.
- `join-info` returns `{ host, port, token, authEnabled }` — the values the UI
  renders into a copy-paste `ndh runner join …` pairing command. **It is gated
  because `token` is the runner-registration capability**: anyone who reads it
  can register rogue runners against the hub (and rogue runners run job code).
  That is why the pairing endpoint is locked to the local operator even though
  the rest of the API is open.

**Admitting a remote operator — `--basic-auth user:pass`:**

- Passing `--basic-auth ops:secret` (or `NDH_BASIC_AUTH=ops:secret`) lets a
  **non-local** client reach the UI + `join-info` with HTTP Basic auth,
  compared **timing-safely**. Loopback still bypasses it.
- A malformed value (no colon) is **ignored with a warning**
  (`[ndh] --basic-auth must be user:pass — ignoring`) and the UI stays
  loopback-only — verified. Basic auth over plain HTTP only makes sense on a
  trusted network or behind TLS.

**Still open on `4949` to anyone who can reach the port:**

- The REST/Actions **API**, the **runner long-poll protocol**, and the
  **action mirror**. `--basic-auth` and the loopback gate cover the UI +
  pairing endpoint **only** — they do not authenticate the API. Runner
  *registration* remains gated by the token (unless `--no-auth`). Net: treat
  `4949` as a **LAN / tailnet** surface; never expose it publicly, and don't
  hand out the registration token.

---

## Logging

Every long-running or one-shot `ndh` process writes a **daily-rotating** file
log next to its state, in addition to the console:

| Command | Log path |
|---|---|
| `ndh hub up` | `~/.notdownhub/hub/logs/hub-YYYY-MM-DD.log` (includes teed `Runner.Server` output) |
| `ndh runner start <name>` | `~/.notdownhub/runners/<name>/logs/runner-YYYY-MM-DD.log` |
| `ndh run` | `~/.notdownhub/logs/run-YYYY-MM-DD.log` |
| `ndh dispatch` | `~/.notdownhub/logs/dispatch-YYYY-MM-DD.log` |

Properties (verified against real files):

- **Files are `0600`, directories `0700`** — logs can contain job output, so
  they're owner-only.
- **`[ndh] …` lines are ISO-8601 timestamped** (e.g.
  `2026-08-07T00:03:14.483Z [ndh] hub up on …`); child process output is teed in
  as-is.
- **ANSI colour is stripped** in the file, so logs stay greppable.
- **Rotation** is by calendar day, rolled at midnight even for a hub that runs
  for weeks; the newest **14 days** are kept and older files pruned (default).
- The startup banner prints the active path: `[ndh] logging to … (daily
  rotation)`.

> **Colour trade-off:** to tee child output to the log, `ndh run` / `dispatch` /
> `runner start` pipe the child's stdio instead of inheriting the TTY. The child
> therefore sees a non-TTY and emits **plain (uncoloured)** output in your
> terminal while logging is active. The hub is unaffected in this regard (its
> banner colour is ndh's own). Tail a live log with `tail -f`:
> ```bash
> tail -f ~/.notdownhub/hub/logs/hub-$(date +%F).log
> ```

---

## State & backup

Everything is under `NDH_HOME` (default `~/.notdownhub`). What to protect:

| Item | Path | Back up? | If lost |
|---|---|---|---|
| Fleet + run history | `hub/hub.db` (`+ -wal`, `-shm`) | **Yes** | Runners must re-join; run history gone. |
| Registration token | `hub/runner-token` | **Yes** (secret, `0600`) | A new token is generated; every runner must re-join with it. |
| Action mirror cache | `mirror/` | For offline/air-gapped | Re-fetched from GitHub on next use (needs network). |
| Runner instances | `runners/<name>/` | Optional | Recreate with `ndh runner join` (its `.credentials_rsaparams` is the runner's private key). |
| `ndh secrets` store | macOS Keychain (`notdownhub:<scope>`), or `secrets.json` **+** `secrets.key` on other OSes | **Yes** (secret) | Stored secrets are gone. |
| Vendor bundle + cache | `vendor/`, `cache/` | No | Recreate with `ndh install`. |

Back up the whole `hub/` directory to snapshot fleet + token together. Because
SQLite uses WAL, either stop the hub first or copy `hub.db`, `hub.db-wal`, and
`hub.db-shm` together (or use `sqlite3 hub/hub.db ".backup <dest>"` for a live,
consistent copy). `vendor/`, `cache/`, and (online) `mirror/` are fully
disposable. For the **exhaustive** file inventory (including files written
outside `NDH_HOME`) see [files.md](files.md).

---

## Runner fleet operations

### Joining

```bash
ndh runner join http://hub-host:4949 --token <token> \
    --name build-box-1 --labels self-hosted,linux,X64
```

```
# Runner Registration
√ Runner successfully added
√ Runner connection is good
# Runner settings
√ Settings Saved.
[ndh] runner 'build-box-1' joined http://hub-host:4949
[ndh] start it: ndh runner start build-box-1
```

- **Token handling:** `--token` **must** match the hub's `hub/runner-token`
  unless the hub runs `--no-auth`. If you omit it, `ndh` sends the literal
  `notdownhub`, which fails against an auth-on hub. Pass the token the hub
  printed at startup; it's stable across restarts.
- **Defaults:** `--name` defaults to `<hostname>-ndh`; `--labels` defaults to
  `self-hosted,<OS>,<arch>` derived from the host.
- `join` copies the bundle into `runners/<name>/bin/` and configures with
  `--replace`, so re-joining an existing name cleanly overwrites it.

### Starting (and starting at boot)

```bash
ndh runner start build-box-1
```

```
[ndh] runner 'build-box-1' listening for jobs (ctrl-c to stop)
√ Connected to GitHub
Current runner version: '3.14.0'
2026-… : Listening for Jobs
```

With exactly one joined runner you can omit the name (`ndh runner start`); with
zero or several it asks you to specify which. `ndh runner list` prints joined
names. To start at boot, wrap it in a service (below) or use the
[Docker runner image](install.md#4-docker-fleet-runner-image).

### Multiple runners per machine

Each runner is a separate `runners/<name>/` instance (its own `bin/`,
`.runner`, `.credentials`), so one machine can host several:

```bash
ndh runner join http://hub:4949 --token <t> --name box-a --labels self-hosted,gpu
ndh runner join http://hub:4949 --token <t> --name box-b --labels self-hosted,cpu
ndh runner start box-a   # in one shell / service
ndh runner start box-b   # in another
```

### Renaming / re-joining after a hub reset

If the hub's `hub.db` is wiped (or you migrate to a new hub), existing runner
processes keep retrying against a registration the server no longer knows.
Re-join to refresh identity:

```bash
ndh runner join http://hub:4949 --token <new-token> --name build-box-1 --labels …
ndh runner start build-box-1
```

`--replace` (always passed) reclaims the name on the server. To *rename*, join
under the new name — the old `runners/<old>/` instance can then be removed.

### Removing a runner

Stop the process (Ctrl-C / stop the service), then delete its instance
directory:

```bash
rm -rf ~/.notdownhub/runners/build-box-1
```

For a Docker runner, `docker rm -f <container>` (and its state volume if you
created one). The stale agent row lingers in `ndh status` until the hub prunes
it or you replace the name.

---

## Running the hub as a service

### macOS (launchd)

`~/Library/LaunchAgents/dev.notdownhub.hub.plist` — adjust the two paths and
the username:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.notdownhub.hub</string>
  <key>ProgramArguments</key>
  <!-- npm-global install: use ["<path to ndh>", "hub", "up", …] (find it with `command -v ndh`).
       From source: call node on the built entry point, as shown here. -->
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/notdownhub/packages/cli/dist/index.js</string>
    <string>hub</string>
    <string>up</string>
    <string>--host</string>
    <string>hub.tailnet</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NDH_HOME</key><string>/Users/you/.notdownhub</string>
    <key>GITHUB_TOKEN</key><string>ghp_xxx</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/.notdownhub/hub.out.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.notdownhub/hub.err.log</string>
</dict>
</plist>
```

```bash
launchctl load  ~/Library/LaunchAgents/dev.notdownhub.hub.plist   # start + enable
launchctl unload ~/Library/LaunchAgents/dev.notdownhub.hub.plist  # stop + disable
```

### Linux (systemd)

`/etc/systemd/system/ndh-hub.service`:

```ini
[Unit]
Description=notdownhub hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ndh
Environment=NDH_HOME=/home/ndh/.notdownhub
Environment=GITHUB_TOKEN=ghp_xxx
# npm-global install: ExecStart=/usr/local/bin/ndh hub up --host hub.internal (see `command -v ndh`)
ExecStart=/usr/bin/node /opt/notdownhub/packages/cli/dist/index.js hub up --host hub.internal
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ndh-hub
sudo journalctl -u ndh-hub -f          # follow logs (grab the token here)
```

A runner can be supervised the same way — swap `ExecStart` for
`… index.js runner start <name>` in an `ndh-runner.service`. Set
`Environment=COREPACK_ENABLE_DOWNLOAD_PROMPT=0` on runner units so jobs that use
corepack don't hang (see troubleshooting).

---

## Hub restart semantics

`ndh` persists fleet + runs in SQLite (`hub/hub.db`), so a restart is
non-destructive:

- **Token survives.** The restarted hub reuses `hub/runner-token` — the same
  registration token as before (verified: identical token across a stop/start).
- **Runners survive.** Registered agents are read back from SQLite; `ndh status`
  lists them again immediately after the hub is back, before any runner has
  reconnected.
- **Runners auto-reconnect.** A running `ndh runner start` retries on a short
  loop and logs `Runner connect error: Connection refused … Retrying until
  reconnected.` during the gap, then `√ Connected to GitHub` once the hub is
  back — typically within ~30s, no manual action.
- **During the window,** clients hit the front while the server is still coming
  up and get `502` (`ndh status` prints `_apis/v1/AgentPools: 502`), or a
  connection error if the front itself isn't up yet. A `dispatch` launched into
  the gap fails to reach the server; retry once `ndh status` responds. A
  dispatch that was already accepted and queued before the restart resumes when
  a matching runner reconnects.

Verify recovery with:

```bash
ndh status --server http://hub-host:4949
# runners:
#   build-box-1  []
# recent runs:
#   …
```

---

## Mirror operations

The hub's action mirror caches `uses:` archives so workflows keep running during
a GitHub outage or fully offline.

- **Warm-up for offline use:** run each workflow once *online* so every action
  it references gets cached. First fetch logs a miss; subsequent fetches are
  silent cache hits (verified: `curl` of `/mirror/actions/checkout/tarball/v4.2.2`
  logged `[ndh] mirror miss — fetching actions/checkout@v4.2.2 (tarball)` and
  wrote `mirror/actions/checkout/tarball-v4.2.2.tgz`; a second request served
  the same bytes with no miss and no network).
- **Cache location:** `NDH_HOME/mirror/<owner>/<repo>/<kind>-<ref>.tgz`.
- **Pruning:** it's a plain file tree — delete entries or the whole `mirror/`
  directory to reclaim space; anything removed is re-fetched on next use (needs
  network). Copy `mirror/` to another host to seed an air-gapped hub.
- **Rate limits:** anonymous GitHub API has a low hourly limit that a big
  warm-up can exhaust. Set `GITHUB_TOKEN` in the **hub's** environment (or pass
  `--github-token`) so mirror fetches send an authenticated request.
- **Disable it:** `ndh hub up --no-mirror-rewrite` leaves `uses:` resolving
  straight from GitHub (no offline capability, no `--host` dependency).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `GitHub Actions is not properly configured in GHES` | The `Host` header the server saw wasn't the public host it mints tenant URLs from — usually a reverse proxy rewriting `Host`, or a client pointed at the internal `:4950` instead of the front. | Reach the hub via the public URL it printed (port 4949), not `:4950`. If fronting with nginx/caddy, pass the original `Host` through untouched (`proxy_set_header Host $host;`). |
| `Connection refused (localhost:80)` when an **official** `actions/runner` registers | The stock GitHub runner drops non-standard ports at registration and falls back to `:80`/`:443`. | Use `ndh runner join` (the bundled fork listener accepts any port), **or** expose the hub on `:443` with TLS so a stock runner can attach. |
| `No runner is registered for the requested runs-on labels` | No *started* runner has labels matching the job's `runs-on`, or you dispatched during the post-restart reconnect window. | `ndh status` to see who's connected; start a runner whose `--labels` include every `runs-on` label; after a hub restart wait ~30s for reconnect. Remember labels are AND-matched. |
| Mirror error `Connection refused` to `127.0.0.1` on a **remote** runner | Hub baked `127.0.0.1` into mirror URLs — an old pre-`--host` build, or `--host` set to a loopback/unreachable address. | Restart the hub on a current build with `--host <lan-ip-or-dns>` reachable from the runner; confirm the URL the runner is dialing. |
| Job hangs at a corepack "download pnpm?" prompt | corepack prompts interactively the first time it provisions a package manager. | Set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` in the workflow `env:` or the runner's service environment (the repo's `remote-ci.yml` does this). |
| `runner join` / start says the runner is `already configured` | A stale `.runner` from a previous registration in the instance dir. | `join` already passes `--replace`; if it persists, `rm -rf ~/.notdownhub/runners/<name>` and re-join. For Docker, recreate the container (fresh, or with a clean state volume). |
| New hub won't start: `EADDRINUSE` on 4949, or a stray `Runner.Server` on 4950 | Restarted before the OS released the public port; front and server are separate processes. | Wait for the port to free (`while lsof -iTCP:4949 -sTCP:LISTEN -t; do sleep 1; done`), kill any orphan holding 4950, then start. Prefer a supervised service. |
| `ndh status` shows a runner with empty `[]` labels | v0.1 cosmetic: `status` lists the agent name but doesn't render its labels. | Not fatal — the labels are still registered and matched for dispatch; confirm them from the `--labels` you joined with. |
| Web UI / `GET /api/local/join-info` returns `403` (`the notdownhub UI is local-only…`) or `401` from another machine | By design: the UI + pairing endpoint are loopback-only; `403` when no `--basic-auth`, `401` when it's set and creds are missing/wrong. | Open the UI on the hub itself (`http://localhost:4949`) or over an SSH tunnel; to admit a remote operator, start the hub with `--basic-auth user:pass` (or `NDH_BASIC_AUTH`) and send those credentials. The API/runner protocol/mirror are unaffected. |
| Startup logs `--basic-auth must be user:pass — ignoring` | The `--basic-auth` / `NDH_BASIC_AUTH` value had no colon, so it was rejected and the UI stayed loopback-only. | Pass it as `user:pass` (a single colon-separated string). |

---

## Upgrading the runner stack

The `runner.server` version is pinned in code, so upgrading is a deliberate
change:

1. Bump `VENDOR_VERSION` in `packages/cli/src/lib.ts` (and the
   `RUNNER_SERVER_VERSION` arg in `docker/runner/Dockerfile` for the fleet
   image).
2. `pnpm -r build`.
3. `ndh install` — downloads the new bundle into a **version-specific** dir
   (`vendor/runner.server-<new>/`); the old one is left in place.
4. Rebuild the Docker image (`docker build …`) and recreate runner containers.

What survives an upgrade (all keyed on `NDH_HOME`, not version): `hub/hub.db`,
`hub/runner-token`, and the `mirror/` cache. What to refresh: **host runner
instances** under `runners/<name>/` still hold a copy of the *old* bundle from
when they joined — re-run `ndh runner join <hub> --token … --name <name>` to
re-copy the new binaries (or delete `runners/<name>/bin` and re-join). Restart
the hub after step 3 to pick up the new server binary.
