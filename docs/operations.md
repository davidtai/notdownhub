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
| `--no-mirror-rewrite` | off | Do not route `uses:` through the mirror. |
| `--no-ui` | off | Serve API/protocol only, no static UI. |

### Stop

Run `ndh hub down` to stop a hub. It reads the pid file at `hub/hub.pid`, sends
`SIGTERM` to the front and the `Runner.Server` child, and escalates to `SIGKILL`
after a short grace. It then confirms both ports are free and prints one line per
action. The command is idempotent: with nothing running it prints `no hub
running` and exits `0`.

Interactively, Ctrl-C the foreground `ndh hub up` instead (or send it `SIGINT`
or `SIGTERM`). The front forwards the signal to the child, removes the pid file,
and exits.

`ndh hub down` also removes the fast-restart hazard. It confirms the ports are
free before it returns, so an `up`, `down`, `up` cycle does not race the OS into
`EADDRINUSE`. A second `ndh hub up` while one hub already runs now exits `1` with
a single line and leaves no orphaned `Runner.Server`:

```bash
ndh hub down   # stop the hub + Runner.Server, free the ports
ndh hub up     # safe to start again at once
```

**Manual fallback (troubleshooting).** A missing or stale pid file (after a hard
reboot) makes `ndh hub down` refuse to guess. It names any port still held
instead of killing by port scan. Stop the hub by hand in that case: target the
parent `ndh` process, not the child. Killing only the child leaves the front
proxying to nothing, and clients get `502`. Wait for the public port to release,
then clear any stray `Runner.Server` on `--hub-port` (4950):

```bash
# wait until the public port is free, then start
while lsof -nP -iTCP:4949 -sTCP:LISTEN -t >/dev/null 2>&1; do sleep 1; done
ndh hub up
```

A supervised service (below) avoids the manual path.

### Ports & firewall

- **`4949` (public):** the *only* port that must be reachable by runners,
  developers, and browsers. It carries the UI, REST/Actions API, the runner
  long-poll protocol, and the mirror.
- **`4950` (internal):** `Runner.Server`; the front proxies to it over
  loopback. **Do not expose it.** (`ndh` binds it on `*` so the front can reach
  it, so block it at the firewall.)
- Open `4949/tcp` to your LAN or tailnet only. The hub **API, runner protocol,
  and mirror are unauthenticated** on this port. Only runner *registration* is
  token-gated; the UI and pairing endpoint are loopback-gated (see
  [Security model](#security-model-v01)). Never put `4949` on the public
  internet. Prefer a private network, VPN, or tailnet. Example (ufw):
  `sudo ufw allow in on tailscale0 to any port 4949`.

### `--host` selection (and why mirror URLs depend on it)

When the mirror rewrite is on (the default), the hub tells each runner to fetch
`uses:` actions from `http://<host>:<port>/mirror/...`. **The runner dials that
URL itself**, so `<host>` must be reachable *from the runner*, not only from the
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
  renders into a copy-paste `ndh runner join …` pairing command. It is gated
  because `token` is the runner-registration capability. Anyone who reads it can
  register rogue runners, and rogue runners run job code. This is why the
  pairing endpoint is locked to the local operator, even when the rest of the
  API is open.

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
  `4949` as a **LAN / tailnet** surface; never expose it publicly, and do not
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
  they are owner-only.
- **`[ndh] …` lines are ISO-8601 timestamped** (e.g.
  `2026-08-07T00:03:14.483Z [ndh] hub up on …`); child process output is teed in
  as-is.
- **ANSI colour is stripped** in the file, so logs stay greppable.
- **Rotation** is by calendar day. The log rolls at midnight, even for a hub
  that runs for weeks. The newest **14 days** are kept; older files are pruned
  (default).
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
  printed at startup; it is stable across restarts.
- **Defaults:** `--name` defaults to `<hostname>-ndh`; `--labels` defaults to
  `self-hosted,<OS>,<arch>` derived from the host.
- `join` copies the bundle into `runners/<name>/bin/` and configures with
  `--replace`. Joining a name that already exists is refused, because it would
  clobber a live registration. Pass `--re-join` to refresh one: it unregisters
  the old instance, re-copies the current bundle, and configures fresh in place.

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
zero or several it asks you to specify which. `ndh runner list` shows the
instances joined on this machine, each with its labels and whether it is running.
`ndh runner list --server <hub>` shows the hub's whole fleet instead, with each
runner's busy/idle/offline state. To start at boot, wrap it in a service (below)
or use the [Docker runner image](install.md#4-docker-fleet-runner-image).

### Removing

```bash
ndh runner remove build-box-1 --token <token>
```

```
[ndh] stopped listener for 'build-box-1'
# Runner removal
√ Runner removed successfully
[ndh] unregistered 'build-box-1' from the hub
[ndh] removed runner 'build-box-1'
```

`remove` retires an instance in three steps. First it stops the listener process
if one is running. It sends SIGTERM, then SIGKILL after a 5-second grace. Next it
unregisters the agent from the hub with the vendored runner's own removal flow.
This is the counterpart of `join`'s configure step. Last it deletes
`runners/<name>/`.

Without this the agent lingers **Offline** in the UI and in `ndh status` forever.

- **Token handling:** the unregister step authenticates with the hub's
  registration token, same as `join`. Pass `--token <token>`. When `remove` runs
  on the hub machine, it also reads the hub's persisted `hub/runner-token`
  automatically.
- **`--force`:** skip the hub step and remove the instance offline. Use it when
  the hub is gone for good. The agent is not unregistered, so delete it from the
  hub separately if the hub still exists.
- **Hub unreachable:** `remove` does not hang if the hub cannot be reached. It
  warns that the hub can still list the agent. It then stops the listener and
  deletes the directory.
- **Unknown name / idempotent:** an unknown name exits `1` and lists the known
  instances. A second `remove` of an already-removed runner takes the same path.

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

The hub's `hub.db` can be wiped, or you can migrate to a new hub. Existing
runner processes then keep retrying against a registration the server no longer
knows. Re-join with `--re-join` to refresh the identity:

```bash
ndh runner join http://hub:4949 --token <new-token> --name build-box-1 --labels … --re-join
ndh runner start build-box-1
```

`--re-join` unregisters the old instance first (tolerating an unreachable old
hub), then `--replace` (always passed) reclaims the name on the server. To
*rename*, join under the new name — the old `runners/<old>/` instance can then
be removed.

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
corepack do not hang (see troubleshooting).

---

## TLS with a self-signed certificate

The hub can serve HTTPS with a certificate that it creates for you.

Start the hub with TLS:

```bash
ndh hub up --tls
```

Facts about `--tls`:

- The public port becomes 443. Use `--port <n>` to select a different port.
- The first start creates a self-signed certificate for the `--host` value. The files are `~/.notdownhub/hub/tls/key.pem` and `cert.pem`.
- The hub log prints the certificate path and the SHA-256 fingerprint.
- You can use your own certificate: `ndh hub up --tls --tls-cert <pem> --tls-key <pem>`.

**Caution:** each runner must trust the self-signed certificate before it can join.

1. Copy `cert.pem` from the hub machine to the runner machine.
2. Join with the certificate: `ndh runner join https://<hub-host> --token <token> --ca <path-to-cert.pem>`.
3. The runner stores the certificate and trusts it for `configure` and `run`.

More facts:

- On macOS, the hub can bind port 443 without root.
- On Linux, port 443 requires root or `setcap cap_net_bind_service=+ep`. You can also use `--port 8443`.
- A hub on TLS port 443 can accept an unmodified official `actions/runner`. The official runner drops non-standard ports at registration, so `--tls` on port 443 is the one configuration that supports it.
- For `ndh dispatch` and `ndh status` against a TLS hub, set `NODE_EXTRA_CA_CERTS=<path-to-cert.pem>` and `SSL_CERT_FILE=<path-to-cert.pem>` in your shell.

## Run the hub on a VM

You can run the hub on a small cloud VM. One vCPU and 1 GB of memory are enough
for a small fleet.

If you want to set up the hub in the cloud, you can use this DigitalOcean
referral link. **This is a referral link.** You get $25 of credit, and we get
$25 of credit. The $25 credit is enough to try notdownhub on a small VM for
several months.

https://m.do.co/c/f23823c4f5b4

Steps on the VM:

1. Install `ndh` (see [install.md](install.md)).
2. Start the hub with `--host` set to the VM's public DNS name or IP:
   ```bash
   ndh hub up --host hub.example.com
   ```
3. Open port 4949 to your runners. Restrict the source to your fleet where you
   can. You can also front the port with TLS, as the security model describes.
4. Copy the registration token from the startup log (or
   `~/.notdownhub/hub/runner-token`). Give it to each runner with
   `ndh runner join <hub-url> --token <token>`.

**Caution:** on the VM the web UI stays loopback-only. Reach it over an SSH
tunnel, or start the hub with `--basic-auth user:pass` to admit a remote
operator. See the [Security model](#security-model-v01).

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
  loop. During the gap it logs `Runner connect error: Connection refused …
  Retrying until reconnected.`. It then logs `√ Connected to GitHub` once the
  hub is back — typically within ~30s, with no manual action.
- **During the window,** the server is still coming up. Clients hit the front
  and get `502` (`ndh status` prints `_apis/v1/AgentPools: 502`), or a
  connection error if the front itself is not up yet. A `dispatch` launched into
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
  it references gets cached. The first fetch logs a miss; later fetches are
  silent cache hits. Verified: a `curl` of `/mirror/actions/checkout/tarball/v4.2.2`
  logged `[ndh] mirror miss — fetching actions/checkout@v4.2.2 (tarball)` and
  wrote `mirror/actions/checkout/tarball-v4.2.2.tgz`. A second request served
  the same bytes with no miss and no network.
- **Cache location:** `NDH_HOME/mirror/<owner>/<repo>/<kind>-<ref>.tgz`.
- **Pruning:** the cache is a plain file tree. Delete entries or the whole
  `mirror/` directory to reclaim space. Anything removed is re-fetched on next use (needs
  network). Copy `mirror/` to another host to seed an air-gapped hub.
- **Rate limits:** anonymous GitHub API has a low hourly limit that a big
  warm-up can exhaust. Set `GITHUB_TOKEN` in the **hub's** environment (or pass
  `--github-token`) so mirror fetches send an authenticated request.
- **Disable it:** `ndh hub up --no-mirror-rewrite` leaves `uses:` resolving
  straight from GitHub (no offline capability, no `--host` dependency).

---

## Secrets & variables

`ndh secrets` and `ndh vars` hold values on the machine you dispatch from. They
inject into every `ndh run` and `ndh dispatch`. Secrets feed the
`${{ secrets.NAME }}` context; variables feed `${{ vars.NAME }}`.

### Variables

Set a plain variable, then read it in a workflow as `${{ vars.NAME }}`:

```bash
ndh vars set DEPLOY_TARGET staging
# [ndh] stored var DEPLOY_TARGET (scope: global)
```

Reference it from any step:

```yaml
env:
  TARGET: ${{ vars.DEPLOY_TARGET }}
```

`ndh vars set NAME` with no value reads the value from stdin. `ndh vars list`
prints every variable with its value, because variables are not secret.

### Secrets

Store a secret by hidden prompt, piped stdin, or `--value`:

```bash
ndh secrets set NPM_TOKEN                       # hidden prompt (no echo)
echo -n "$TOKEN" | ndh secrets set NPM_TOKEN    # piped stdin (scripting)
ndh secrets set NPM_TOKEN --value "$TOKEN"      # inline (avoid on shared shells)
```

Piped stdin keeps newlines, so a multiline secret round-trips faithfully:

```bash
# a PEM file, TLS key, or any multiline value:
ndh secrets set DEPLOY_KEY < deploy_key.pem
```

`ndh secrets get NAME` reveals a value; it is the only command that prints one.
`ndh secrets list` shows names and scopes, never values.

A secret named `GITHUB_TOKEN` injects as `${{ secrets.GITHUB_TOKEN }}`. It is
separate from the hub's `--github-token`, which the action mirror uses.

### Scopes

A secret or variable is `global` by default, or scoped to one repo with
`--repo owner/name`. A repo scope overrides a global of the same name at run
time. A bare `--repo` (no value) uses the current repo's `origin` remote slug.

```bash
ndh secrets set NPM_TOKEN --repo my-org/my-service   # only that repo
ndh vars set DEPLOY_TARGET prod --repo my-org/my-service
ndh secrets list --repo my-org/my-service
```

### How values reach a run

At `ndh run` or `ndh dispatch` time, `ndh` resolves the effective set on the
dispatching machine: global first, then the repo scope on top. It writes secrets
to an ephemeral `0600` file passed as `--secret-file`, and variables to a
`--var-file`, then deletes both after the run. Values never appear on the
command line or in logs. The remote runner receives only what the dispatch
resolved, so store each value on the machine you dispatch from — not on the
runner.

### Backends

`ndh secrets` uses a real OS keyring by default: the macOS Keychain, or the
Linux Secret Service when it is available. Headless Linux and Windows fall back
to an encrypted file (`secrets.json` + `secrets.key`), which is
obfuscation-at-rest only. Switch with `ndh secrets backend keyring|file`, and
check the active backend with `ndh secrets backend`. Variables are never
sensitive, so they live in a plain `0600` file (`vars.json`) that `ndh vars
list` reads back.

For each backend's exact files and sensitivity, see [files.md](files.md).

---

## Triggering CI

GitHub webhooks do not reach your hub. Start a run through one of three paths:

- `ndh dispatch` from a repo checkout. This is the direct path.
- A webhook from your git server or forge.
- An `on: schedule` trigger in a workflow.

The three paths are coherent: each one hands a workflow to the hub. The rest of
this section covers the git-server path in detail.

### Trigger CI from a git server

A bare git server can trigger CI on a branch update. A `post-receive` hook
checks out each pushed branch to a temporary work-tree. It then runs
`ndh dispatch` against your hub for that tree.

Install the hook with one command:

```bash
ndh hook install /srv/git/app.git --server http://hub.tailnet:4949
```

Add `-W .github/workflows/ci.yml` to dispatch one workflow. The default
dispatches all workflows. Use `--force` to overwrite a hook ndh did not write.
The command validates the path, confirms a bare repo, and writes an executable
`post-receive` hook.

The manual recipe below explains what the generated hook does. Use it on a
server without `ndh hook install`. This recipe was verified live against a bare
repo and a running hub:

```bash
#!/usr/bin/env bash
# .git/hooks/post-receive on a bare repo: dispatch CI for each updated branch.
set -euo pipefail

HUB=http://hub.tailnet:4949
WORKFLOW=.github/workflows/ci.yml

while read -r _old new ref; do
  case "$ref" in refs/heads/*) ;; *) continue ;; esac
  branch=${ref#refs/heads/}
  work=$(mktemp -d)
  git --work-tree="$work" checkout -f "$new"
  ( cd "$work" && ndh dispatch --server "$HUB" -W "$WORKFLOW" --event push )
  rm -rf "$work"
  echo "[hook] dispatched $branch"
done
```

Make the hook executable (`chmod +x .git/hooks/post-receive`) on the server.

The hook needs `ndh` on its PATH. Set an absolute path, or export PATH in the
hook. The dispatch reads secrets from the server that runs the hook, not from
the git remote.

A full forge can replace this hook. Gitea and Forgejo can point a webhook at the
hub instead.

### Branch tracking

A workflow with `on: push: branches:` runs only for the branches it lists. The
engine evaluates the filter against the ref the event claims, exactly like a
GitHub push. `--ref refs/heads/<branch>` sets that ref; the checked-out tree is
always the local working tree you dispatch from.

Confirm the filter with two dispatches of a workflow that tracks `main`. A
non-tracked ref is skipped; the tracked ref runs to completion:

```bash
# Non-tracked ref — the engine skips the workflow:
ndh dispatch --server http://hub.tailnet:4949 -W .github/workflows/ci.yml \
    --event push --ref refs/heads/feature
# Skipping Workflow, due to branches filter. github.ref='refs/heads/feature'
# All Workflows skipped, due to filters

# Tracked ref — the workflow runs to completion:
ndh dispatch --server http://hub.tailnet:4949 -W .github/workflows/ci.yml \
    --event push --ref refs/heads/main
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `GitHub Actions is not properly configured in GHES` | The `Host` header the server saw was not the public host it mints tenant URLs from — usually a reverse proxy rewriting `Host`, or a client pointed at the internal `:4950` instead of the front. | Reach the hub via the public URL it printed (port 4949), not `:4950`. If fronting with nginx/caddy, pass the original `Host` through untouched (`proxy_set_header Host $host;`). |
| `Connection refused (localhost:80)` when an **official** `actions/runner` registers | The stock GitHub runner drops non-standard ports at registration and falls back to `:80`/`:443`. | Use `ndh runner join` (the bundled fork listener accepts any port), **or** expose the hub on `:443` with TLS so a stock runner can attach. |
| `No runner is registered for the requested runs-on labels` | No *started* runner has labels matching the job's `runs-on`, or you dispatched during the post-restart reconnect window. | `ndh status` to see who's connected; start a runner whose `--labels` include every `runs-on` label; after a hub restart wait ~30s for reconnect. Remember labels are AND-matched. |
| Mirror error `Connection refused` to `127.0.0.1` on a **remote** runner | Hub baked `127.0.0.1` into mirror URLs — an old pre-`--host` build, or `--host` set to a loopback/unreachable address. | Restart the hub on a current build with `--host <lan-ip-or-dns>` reachable from the runner; confirm the URL the runner is dialing. |
| Job hangs at a corepack "download pnpm?" prompt | corepack prompts interactively the first time it provisions a package manager. | Set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` in the workflow `env:` or the runner's service environment (the repo's `remote-ci.yml` does this). |
| `runner join` / start says the runner is `already configured` | An older `ndh` did not clear the local `.runner` before re-configuring. | Re-join with `ndh runner join … --re-join` (it unregisters and rebuilds the instance for you), or `ndh runner remove <name>` and join again. For Docker, recreate the container (fresh, or with a clean state volume). |
| New hub will not start, or `ndh hub up` prints `a hub is already running on :4949` | A hub (or a stray `Runner.Server`) still holds the port; the pre-flight check now refuses instead of crashing with `EADDRINUSE`. | `ndh hub down` to stop the previous hub and free both ports, then `ndh hub up`. If `hub down` reports the pid file is stale but a port is still held, an unrelated process owns it — find it with `lsof -iTCP:4949 -sTCP:LISTEN` and stop it. Prefer a supervised service. |
| `ndh status` shows a runner with empty `[]` labels | v0.1 cosmetic: `status` lists the agent name but does not render its labels. | Not fatal — the labels are still registered and matched for dispatch; confirm them from the `--labels` you joined with. |
| Web UI / `GET /api/local/join-info` returns `403` (`the notdownhub UI is local-only…`) or `401` from another machine | By design: the UI + pairing endpoint are loopback-only; `403` when no `--basic-auth`, `401` when it is set and creds are missing/wrong. | Open the UI on the hub itself (`http://localhost:4949`) or over an SSH tunnel; to admit a remote operator, start the hub with `--basic-auth user:pass` (or `NDH_BASIC_AUTH`) and send those credentials. The API/runner protocol/mirror are unaffected. |
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

These survive an upgrade, because they are keyed on `NDH_HOME`, not the version:
`hub/hub.db`, `hub/runner-token`, and the `mirror/` cache. Host runner instances
under `runners/<name>/` need a refresh. Each one still holds a copy of the *old*
bundle from when it joined. Re-run `ndh runner join <hub> --token … --name <name> --re-join`
to re-copy the new binaries (this refreshes the bundle in place), or
`ndh runner remove <name>` and join again. Restart the hub after step 3 to load
the new server binary.
