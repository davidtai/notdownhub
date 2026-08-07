<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/davidtai/notdownhub/main/assets/brand/logo-dark.svg">
  <img src="https://raw.githubusercontent.com/davidtai/notdownhub/main/assets/brand/logo-light.svg" alt="notdownhub — a computer carried by balloons" width="120" height="150">
</picture>

# notdownhub (`ndh`)

**GitHub can go down. Your CI does not have to.**

[![npm](https://img.shields.io/npm/v/notdownhub)](https://www.npmjs.com/package/notdownhub)
![status](https://img.shields.io/badge/status-alpha-orange)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/davidtai/notdownhub/blob/main/LICENSE)
[![website](https://img.shields.io/badge/site-notdownhub.com-f2663b)](https://notdownhub.com)

[**notdownhub.com**](https://notdownhub.com) · [Docs](https://github.com/davidtai/notdownhub/tree/main/docs) · [Repo](https://github.com/davidtai/notdownhub)

</div>

`ndh` runs your **unmodified** GitHub Actions workflows on infrastructure you
control — your laptop, one box under a desk, or a fleet of machines behind NAT.
Same YAML, same `runs-on`, same `actions/checkout@v4`, same matrix and `needs:`
graph. No re-implemented engine. No forge to run. No GitHub Enterprise invoice.
After the first run it works fully offline.

notdownhub is a thin product wrapper (the `ndh` CLI) around
[`ChristopherHX/runner.server`](https://github.com/ChristopherHX/runner.server),
a maintained, MIT-licensed fork of GitHub's official
[`actions/runner`](https://github.com/actions/runner). Execution runs on the
official runner codebase, so workflows run with full fidelity — not a
best-effort approximation.

> **Status: Alpha (v0.0.x).** Early software under active development. Interfaces
> and behavior can change between releases. Use at your own risk.

> **Networking (please read):** the hub's port `4949` carries the web UI, an API,
> and the runner protocol — a **LAN / tailnet surface, never public**. If your hub
> and runners span the internet, put them on a private overlay network
> ([Tailscale](https://tailscale.com/) or [WireGuard](https://www.wireguard.com/))
> and bind/firewall `4949` to that interface. Details:
> [operations → security model](https://github.com/davidtai/notdownhub/blob/main/docs/operations.md#security-model-v01).

## Install

**Requirements:** Node.js >= 22.13 (macOS / Linux / Windows on x64 or arm64).

```bash
npm install -g notdownhub   # installs the `ndh` CLI
ndh run                     # run this repo's workflows locally (pulls the runner stack on first run)
```

Prefer not to install globally? Run it one-shot:

```bash
npx notdownhub run          # or: pnpm dlx notdownhub run
```

`ndh run` starts an in-process hub + runner and executes the workflows in the
current repo — no server, no config. On first use it downloads and pins the
`runner.server` stack (~66 MB) into `~/.notdownhub`; run `ndh install` to
pre-warm that download.

```bash
ndh run                                     # all workflows, default `push` event
ndh run -W .github/workflows/ci.yml         # a specific workflow file/dir
ndh run -W .github/workflows/ci.yml --event pull_request
ndh run -l                                  # list the jobs that would run
ndh run -j build -m os:ubuntu-latest        # one job / one matrix leg
```

`ndh run` and `ndh dispatch` pass every flag through to the bundled
`Runner.Client`. Run `ndh run --help` for the full set: `-W/--workflows`,
`--event`, `-j/--job`, `-m/--matrix`, `-s/--secret`, `--env`, `-P/--platform`,
`-C/--directory`, and more.

By default, `ubuntu-*` jobs run in a Linux container when Docker is available.
Otherwise they run on the host. `macos-latest`, `windows-latest`, and
`self-hosted` always run on the host. Override any mapping with `-P`, for example
`-P ubuntu-latest=-self-hosted`.

## Screenshots

The bundled web UI — live logs, run history, projects, your runner fleet, and
write-only secrets. Served by the hub at `http://localhost:4949`.

| | | |
|---|---|---|
| [![Runs](https://raw.githubusercontent.com/davidtai/notdownhub/main/docs/screenshots/runs.png)](https://raw.githubusercontent.com/davidtai/notdownhub/main/docs/screenshots/runs.png)<br>**Runs** | [![Run detail](https://raw.githubusercontent.com/davidtai/notdownhub/main/docs/screenshots/run-detail.png)](https://raw.githubusercontent.com/davidtai/notdownhub/main/docs/screenshots/run-detail.png)<br>**Run detail — live logs** | [![Projects](https://raw.githubusercontent.com/davidtai/notdownhub/main/docs/screenshots/projects.png)](https://raw.githubusercontent.com/davidtai/notdownhub/main/docs/screenshots/projects.png)<br>**Projects** |
| [![Runner fleet](https://raw.githubusercontent.com/davidtai/notdownhub/main/docs/screenshots/runners.png)](https://raw.githubusercontent.com/davidtai/notdownhub/main/docs/screenshots/runners.png)<br>**Runner fleet** | [![Secrets](https://raw.githubusercontent.com/davidtai/notdownhub/main/docs/screenshots/settings.png)](https://raw.githubusercontent.com/davidtai/notdownhub/main/docs/screenshots/settings.png)<br>**Secrets & variables** | |

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

## A fleet across your machines

Start a persistent hub, then attach runners from anywhere — even across NAT
(runners are outbound-only long-pollers).

```bash
# on the hub machine — one public port, web UI + API + runner coordination + mirror
ndh hub up                       # prints a runner registration token

# on each runner machine
ndh runner join http://hub.tailnet:4949 --token <token> --labels self-hosted,linux,X64
ndh runner start

# from any repo you want the fleet to build
ndh dispatch --server http://hub.tailnet:4949 --event push
ndh status   --server http://hub.tailnet:4949     # runners + recent runs
ndh watch <run-id> --server http://hub.tailnet:4949
```

Teams can trigger CI on `git push` via a `post-receive` hook (`ndh hook install`)
so teammates need only `git` — no `ndh`, no tokens. Full, verified walkthroughs:

- [Setup 1 — one repo, your machines](https://github.com/davidtai/notdownhub/blob/main/README.md#setup-1--one-repo-your-machines)
- [Setup 2 — a team on a git server](https://github.com/davidtai/notdownhub/blob/main/docs/collaboration.md)
- [Setup 3 — self-hosted GitLab or any git host](https://github.com/davidtai/notdownhub/blob/main/README.md#setup-3--self-hosted-gitlab-or-any-git-host)

## GitHub Marketplace actions

Workflows use Marketplace actions with the standard `uses:` syntax. The hub
downloads each action from GitHub once through its caching mirror; every later
run reads it from cache. Verified: `actions/checkout`, `actions/setup-node`,
`pnpm/action-setup`, `actions/cache`, `actions/upload-artifact`.

## Offline

The hub ships a transparent, caching action mirror. Warm it once while online.
Your CI then keeps running through a GitHub outage, or on an air-gapped network.
Every run after the first serves actions from `~/.notdownhub/mirror`.

## Documentation

- [Install guide](https://github.com/davidtai/notdownhub/blob/main/docs/install.md) — per-OS prerequisites, `NDH_HOME` layout, Docker fleet-runner image, air-gapped setup
- [Operations runbook](https://github.com/davidtai/notdownhub/blob/main/docs/operations.md) — service setup, security model, TLS, secrets & variables, triggers, backups, upgrades
- [Architecture](https://github.com/davidtai/notdownhub/blob/main/docs/architecture.md) — request flows and the security model
- [Team guide](https://github.com/davidtai/notdownhub/blob/main/docs/collaboration.md) — running CI for a team off a git server

## Attribution

notdownhub is built on two MIT-licensed projects. It wraps and pins the
Actions-protocol server, client, and runner bundle from
[ChristopherHX/runner.server](https://github.com/ChristopherHX/runner.server).
That project forks GitHub's official runner,
[actions/runner](https://github.com/actions/runner). notdownhub itself is an
independent project, MIT-licensed. It is not affiliated with or endorsed by
GitHub, Inc.

## Disclaimer

notdownhub is alpha software, provided "as is", without warranty of any kind. The
authors accept no liability for damage that results from its use. It is not
certified for production-critical CI — validate it against your own workloads
before you depend on it. Full terms:
[LICENSE](https://github.com/davidtai/notdownhub/blob/main/LICENSE) (MIT).
