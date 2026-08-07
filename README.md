<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-dark.svg">
    <img src="assets/brand/logo-light.svg" alt="notdownhub — a computer carried by balloons" width="112" height="144">
  </picture>
</p>

# notdownhub

**GitHub can be down; your CI is not.**

`ndh` runs your **unmodified** GitHub Actions workflows on infrastructure you
control — your laptop, one box under a desk, or a fleet of machines behind
NAT. Same YAML, same `runs-on`, same `actions/checkout@v4`, same matrix and
`needs:` graph. No re-implemented engine. No forge to run. No GitHub
Enterprise invoice. After the first run it works fully offline.

notdownhub is a thin product wrapper (the `ndh` CLI) around
[`ChristopherHX/runner.server`](https://github.com/ChristopherHX/runner.server).
That project is a maintained, MIT-licensed fork of GitHub's official
[`actions/runner`](https://github.com/actions/runner). It adds an
Actions-protocol server and client. Execution runs on the official runner
codebase, so workflows run with full fidelity, not a best-effort approximation.

---

## Why

| | notdownhub | [nektos/act](https://github.com/nektos/act) | Gitea / Forgejo Actions | GitHub Enterprise |
|---|---|---|---|---|
| Runs unmodified workflows | Yes (official runner codebase) | Reimplemented engine — subtle gaps | act-based runner | Yes |
| Local one-shot run | `ndh run` | Yes | No (needs the forge) | No |
| Multi-machine fleet | Yes (`hub` + `runner join`) | No | Yes (per-forge) | Yes |
| Needs a server/forge to exist | No | No | Yes | Yes |
| Works offline after warm-up | Yes (caching action mirror) | Partial | Partial | N/A |
| Cost | Free (MIT) | Free (MIT) | Free (self-host a forge) | $$$ |

`ndh` fits between two extremes: a one-off local run, and a full forge. It runs
the CI you already have — locally or across your own machines — with nothing
pointing at github.com.

---

## 60-second quickstart

**Requirements:** Node.js >= 22.13 (macOS / Linux / Windows on x64 or arm64).

Install the CLI (its bin is `ndh`):

```bash
npm install -g notdownhub
ndh install      # one-time: downloads the pinned runner stack (~66 MB)
ndh run          # run this repo's workflows locally, one-shot
```

Prefer not to install globally? Run it one-shot with your package runner:

```bash
pnpm dlx notdownhub run        # or: npx notdownhub run
```

(Building from a clone instead? See [From source](#from-source).)

`ndh install` downloads and pins `runner.server` **v3.14.0** into
`~/.notdownhub`. `ndh run` starts an in-process hub + runner and executes the
workflows in the current repo — no server, no config.

```bash
ndh run                                        # all workflows, default `push` event
ndh run -W .github/workflows/ci.yml            # a specific workflow file/dir
ndh run -W .github/workflows/ci.yml --event pull_request
ndh run -l                                     # list the jobs that would run
ndh run -j build -m os:ubuntu-latest           # one job / one matrix leg
```

> `ndh run` and `ndh dispatch` pass every flag straight through to the bundled
> `Runner.Client`. Run `ndh run --help` to see the full set (`-W/--workflows`,
> `--event`, `-j/--job`, `-m/--matrix`, `-s/--secret`, `--env`, `-P/--platform`,
> `-C/--directory`, and more).

By default, `ubuntu-*` jobs run in a Linux container
(`catthehacker/ubuntu:act-latest`) when Docker is available, and on the host
otherwise. `macos-latest`, `windows-latest`, and `self-hosted` always run on the
host. Override any mapping with `-P`, e.g. `-P ubuntu-latest=-self-hosted`.

> **Full install guide:** per-OS prerequisites, what `ndh install` downloads
> and the `NDH_HOME` layout, the Docker fleet-runner image, air-gapped setup,
> and how to verify — see **[docs/install.md](docs/install.md)**.

---

## Fleet quickstart

Start a persistent hub, then attach runners from anywhere — even across NAT
(runners are outbound-only long-pollers).

**On the hub machine:**

```bash
ndh hub up                       # one public port (default 4949)
```

This starts the web UI + API + runner coordination + action mirror behind a
single port, prints a **runner registration token**, and stores it at
`~/.notdownhub/hub/runner-token`. State (runners, runs) persists in SQLite at
`~/.notdownhub/hub/hub.db` across restarts.

```
[ndh] hub up on http://localhost:4949  (ui: yes, local-only, auth: on, mirror: on @ http://192.168.1.5:4949/mirror)
[ndh] logging to ~/.notdownhub/hub/logs/hub-2026-08-07.log (daily rotation)
[ndh] runner registration token: 8f3c…
[ndh] join a runner:   ndh runner join http://192.168.1.5:4949 --token 8f3c…
[ndh] dispatch a repo: ndh dispatch --server http://192.168.1.5:4949
```

Useful `hub up` flags:

- `--port <n>` — public port (default 4949).
- `--host <name-or-ip>` — the address the hub advertises to runners for the
  action mirror. The default is the machine's auto-detected primary LAN IPv4, so
  remote runners can reach the mirror (they cannot reach the hub's `127.0.0.1`).
  Override it for a wrong NIC guess or a stable name. Examples: a DNS name
  (`--host hub.internal`) or a tailnet address (`--host hub.tailnet`).
- `--basic-auth <user:pass>` — the web UI and its pairing endpoint are
  **loopback-only** by default; this admits a non-local operator over HTTP
  Basic (env `NDH_BASIC_AUTH`). The API/runner protocol/mirror are open
  regardless — see the security model in [docs/operations.md](docs/operations.md).
- `--github-token <pat>` — give the server a PAT.
- `--no-auth` — disable registration-token auth (open registration).
- `--no-mirror-rewrite` — do not route `uses:` through the mirror.
- `--no-ui` — API only.

**On each runner machine:**

```bash
ndh runner join http://hub.tailnet:4949 --token 8f3c… \
    --labels self-hosted,linux,X64
ndh runner start
```

`join` registers this machine (defaults: name `<hostname>-ndh`, labels derived
from the host OS/arch). `start` begins listening for jobs; with several joined
runners pass a name (`ndh runner start <name>`), and `ndh runner list` shows
what is joined.

**From any repo you want built by the fleet:**

```bash
ndh dispatch --server http://hub.tailnet:4949 --event push
ndh status  --server http://hub.tailnet:4949      # runners + recent runs
```

> **Auth note:** `ndh runner join` defaults `--token` to the literal
> `notdownhub`, which will **not** match a hub's random registration token. On
> an auth-on hub always pass the real `--token` the hub printed. The default is
> only useful against a hub started with `--no-auth`.

No machine to host the hub? You can run it on a small cloud VM. See
[Run the hub on a VM](docs/operations.md#run-the-hub-on-a-vm), which includes a
DigitalOcean referral link with $25 of credit to try it.

---

## Migrate from a GitHub Actions self-hosted runner

Your workflow files do not change. notdownhub runs the same YAML, the same `runs-on` labels, and the same marketplace actions.

Follow these steps to move a runner machine:

1. Start a hub on a machine that you control: `ndh hub up`.
2. On the runner machine, install notdownhub: `npm install -g notdownhub`.
3. Join the machine to the hub: `ndh runner join http://<hub-host>:4949 --token <token>`.
4. Set the same labels that your workflows request in `runs-on`. Use `--labels` when you join.
5. Start the runner: `ndh runner start`.
6. Store each repository secret with `ndh secrets set <NAME>`. The hub does not read secrets from GitHub.
7. Run your CI from a repository checkout: `ndh dispatch --server http://<hub-host>:4949`.

Facts that apply to a migration:

- A runner registration binds to one server. The same machine can hold a GitHub registration and a notdownhub registration at the same time. Jobs do not cross between the two registrations.
- The first run downloads each action one time through the hub mirror. Later runs read the actions from the mirror cache.
- GitHub webhooks do not reach your hub. To start CI, use `ndh dispatch`, a webhook from your git server, or an `on: schedule` trigger. The [operations guide](docs/operations.md) describes each trigger.
- The hub stores artifacts and cache data from `actions/upload-artifact` and `actions/cache`.

## Operations

The runbook covers running a hub in production:
**[docs/operations.md](docs/operations.md)**. It covers the launchd/systemd
service, `--host` selection, firewall rules, backups, restart and reconnect
behavior, mirror warm-up, upgrades, and a troubleshooting table.

---

## Offline story

The hub ships a **transparent, caching action mirror**. The first time a
workflow references, say, `actions/checkout@v4`, the hub fetches the archive
from GitHub and caches it under `~/.notdownhub/mirror`. Every run after that —
including with the network unplugged — serves from cache. Warm the cache once
(online) and your CI keeps running through a GitHub outage or on an air-gapped
network.

Set `GITHUB_TOKEN` in the hub's environment to lift GitHub's anonymous
rate limit while warming the mirror (optional). Disable the rewrite entirely
with `ndh hub up --no-mirror-rewrite`.

---

## Architecture at a glance

```
                    ndh dispatch ──┐            ┌── ndh run  (in-process hub + runner,
                                   │            │            no network, one-shot)
                                   ▼            ▼
   ┌──────────────────────────────────────────────────────┐
   │  ndh hub up            ONE public port (:4949)         │
   │                                                        │
   │   /mirror/*   ──►  caching action mirror ──► github    │
   │   /ui, assets ──►  web UI (static SPA)                 │
   │   everything  ──►  proxy ──► Runner.Server (:4950)     │
   │                    (Actions protocol, SQLite state)    │
   └───────────────────────────▲──────────────────────────┘
                                │ outbound-only long-poll (NAT-friendly)
              ┌─────────────────┼─────────────────┐
              │                 │                 │
        runner join       runner join       runner join
        (laptop)          (build box)       (CI server)
```

`ndh run` needs none of this — it spins up a hub and a runner in-process, runs
your workflows, and exits. The hub exists only when you want a persistent,
multi-machine fleet. Full details, request flows, and the security model:
[docs/architecture.md](docs/architecture.md).

---

## Known limits (v0.1)

- **The hub API, runner protocol, and mirror are unauthenticated.** Only runner
  registration is token-gated. The web UI and the pairing endpoint
  (`/api/local/join-info`) are loopback-only by default. A non-local request
  gets `403`, or `401` with `--basic-auth user:pass`. The rest of the API is
  open on port 4949. Treat the hub as a LAN or tailnet tool, and do not expose
  it to the public internet.
- **An unmodified official `actions/runner` binary can only join a hub on `:443`
  over TLS.** The official runner drops non-standard ports at registration
  (verified with `actions/runner` v2.336.0). The bundled fork listener (used by
  `ndh runner join`) has no such limit, so any port works for `ndh` runners.
  See the port-443 finding in the architecture doc.
- **A runner registration binds to exactly one server.** One machine can hold an
  `ndh`-hub runner and a github.com runner at the same time. No job crosses
  between them (see issues #5, #6).
- This is v0.1. Interfaces and defaults can change.

---

## Attribution

notdownhub stands on two MIT-licensed projects and would not exist without
them:

- **[ChristopherHX/runner.server](https://github.com/ChristopherHX/runner.server)**
  (MIT) — the Actions-protocol server, client, and runner bundle that `ndh`
  wraps and pins (v3.14.0).
- **[actions/runner](https://github.com/actions/runner)** (MIT) — GitHub's
  official Actions runner, which `runner.server` is a fork of and which gives
  `ndh` its execution fidelity.

notdownhub itself is MIT-licensed — see [LICENSE](LICENSE). It is an
independent project and is not affiliated with or endorsed by GitHub, Inc.

## Try it

A ready-to-run sample repo lives in [`examples/demo`](examples/demo) — a matrix
build with `actions/checkout@v4`, job outputs, and a `needs:` graph you can run
with a single `ndh run`.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the dev
setup, the repo layout, and the commit conventions.

Two more documents govern participation:

- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — the community standards.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability in private.

## From source

Contributors (or anyone who wants to run an unreleased build) can clone and
build — the CLI's bin is `ndh`:

```bash
git clone https://github.com/davidtai/notdownhub
cd notdownhub
pnpm install && pnpm -r build
node packages/cli/dist/index.js --version
```

`node packages/cli/dist/index.js` *is* `ndh`; alias it
(`alias ndh="node $PWD/packages/cli/dist/index.js"`) and every `ndh …` command
in these docs works verbatim. Full per-OS build prerequisites are in
[docs/install.md](docs/install.md#from-source).

This repo runs its own CI on `ndh`: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs the same on GitHub and locally with `ndh`. Without Docker, `ndh run` maps
`ubuntu-latest` to the host, so no `-P` flag is needed:

```bash
ndh run -W .github/workflows/ci.yml
```

Verified end-to-end on a macOS/arm64 host (no Docker): checkout → pnpm/Node 22
setup → `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm -r test` all
pass.

The docs follow Simplified Technical English (ASD-STE100). Run `pnpm docs:style`
to check them; CI runs the same check.
