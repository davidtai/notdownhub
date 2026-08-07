<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-dark.svg">
  <img src="assets/brand/logo-light.svg" alt="notdownhub — a computer carried by balloons" width="120" height="150">
</picture>

# notdownhub

**GitHub can go down. Your CI does not have to.**

[![ci](https://github.com/davidtai/notdownhub/actions/workflows/ci.yml/badge.svg)](https://github.com/davidtai/notdownhub/actions/workflows/ci.yml)
![npm](https://img.shields.io/badge/npm-coming%20soon-lightgrey)
[![website](https://img.shields.io/badge/site-notdownhub.com-f2663b)](https://notdownhub.com)

[**notdownhub.com**](https://notdownhub.com) &middot; [Choose your setup](#choose-your-setup) &middot; [Docs](docs/) &middot; [Team guide](docs/collaboration.md)

</div>

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
pointing at github.com. Full details, request flows, and the security model:
[docs/architecture.md](docs/architecture.md).

---

## Choose your setup

Three setups cover the common shapes. Pick the row that matches where your
repo lives. Every command in these setups ran live against the current build;
hosts, paths, and tokens are generalized.

| Setup | Your repo lives | CI trigger |
|---|---|---|
| [1 — one repo, your machines](#setup-1--one-repo-your-machines) | in a local checkout | `ndh run`, or `ndh dispatch` to a hub |
| [2 — a team on a git server](#setup-2--a-team-on-a-git-server) | in a bare repo on a shared server | `git push` (`post-receive` hook) |
| [3 — GitLab or another git host](#setup-3--self-hosted-gitlab-or-any-git-host) | on a self-hosted GitLab or another forge | a server hook, a mirror, or `ndh dispatch` |

---

## Setup 1 — one repo, your machines

Use `ndh run` when one machine is enough: no server, no configuration, one
shot. Start a persistent hub when you want run history, a web UI, or more
build machines. Both forms run the same workflows from the same checkout.

### 60-second quickstart

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

> Each run records its project (`owner/repo`) from the checkout's origin remote,
> so the Runs UI and `ndh status` show which project it belongs to. Without an
> origin remote, the project falls back to `local/<dirname>`. Pass `--repository
> owner/name` to override.

By default, `ubuntu-*` jobs run in a Linux container
(`catthehacker/ubuntu:act-latest`) when Docker is available, and on the host
otherwise. `macos-latest`, `windows-latest`, and `self-hosted` always run on the
host. Override any mapping with `-P`, e.g. `-P ubuntu-latest=-self-hosted`.

> **Full install guide:** per-OS prerequisites, what `ndh install` downloads
> and the `NDH_HOME` layout, the Docker fleet-runner image, air-gapped setup,
> and how to verify — see **[docs/install.md](docs/install.md)**.

### Fleet quickstart

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
- `--tls` — serve HTTPS with a self-signed certificate; the default port
  becomes 443. Runners pin it with `ndh runner join https://… --ca cert.pem`.
  Bring your own certificate with `--tls-cert <pem> --tls-key <pem>`. TLS on
  port 443 is also the one configuration an unmodified official
  `actions/runner` can register against. Details:
  [docs/operations.md](docs/operations.md#tls-with-a-self-signed-certificate).
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

`ndh runner remove <name>` retires an instance. It stops the listener,
unregisters the agent from the hub, then deletes the instance directory. A
removed agent no longer lingers Offline in the UI or in `ndh status`. Pass the
hub's `--token` so the unregister step can authenticate. Add `--force` to skip
the hub and remove a runner offline.

**From any repo you want built by the fleet:**

```bash
ndh dispatch --server http://hub.tailnet:4949 --event push
ndh status  --server http://hub.tailnet:4949      # runners + recent runs
ndh logs  <run-id> --server http://hub:4949       # a finished run's job logs
ndh watch <run-id> --server http://hub:4949       # follow a live run's console
```

`logs` and `watch` work on a run started by anything — the git hook, a schedule,
or another machine. A hook-triggered run is no longer invisible from the CLI.
`watch` streams the live console and exits when the run completes. `logs` reads
the persisted job logs, which are loopback-gated on the hub. Run it on the hub
host, or tunnel the hub port.

> **Auth note:** `ndh runner join` defaults `--token` to the literal
> `notdownhub`, which will **not** match a hub's random registration token. On
> an auth-on hub always pass the real `--token` the hub printed. The default is
> only useful against a hub started with `--no-auth`.

No machine to host the hub? You can run it on a small cloud VM. See
[Run the hub on a VM](docs/operations.md#run-the-hub-on-a-vm), which includes a
DigitalOcean referral link with $25 of credit to try it.

The operations runbook covers the rest of running a hub for real:
launchd/systemd service, firewall rules, backups, upgrades, and a
troubleshooting table — **[docs/operations.md](docs/operations.md)**.

---

## Setup 2 — a team on a git server

One sentence locates every piece: **the git server is the dispatching
machine.** Teammates need only `git` — no `ndh`, no tokens. The server runs
`ndh dispatch` from a `post-receive` hook, with the team's secrets in the
server account. This section is the compact recipe; the full, live-verified
story — topology, roles, branch rules, project labels — is
**[docs/collaboration.md](docs/collaboration.md)**.

**1. Start the hub**, with team access to the web UI:

```bash
ndh hub up --basic-auth ops:PASSWORD
```

The web UI is loopback-only by default. `--basic-auth` admits the team's
browsers with those credentials; without credentials a non-local request gets
`401`.

**2. Join runners** from each build machine, with the token the hub printed:

```bash
ndh runner join http://hub.internal:4949 --token 8f3c… --labels self-hosted
ndh runner start
```

**3. Prepare the git server.** Install `ndh` there
([install.md](docs/install.md)), store the team's values, and install the
hook on each bare repo:

```bash
ndh secrets backend file             # headless account: encrypted file store
ndh secrets set CI_GREETING          # hidden prompt; or pipe the value
ndh vars set DEPLOY_TARGET staging
ndh hook install /srv/git/app.git --server http://hub.internal:4949
```

The hook labels every run with a project slug derived from the repo path
(`/srv/git/app.git` becomes `git/app`). Pass `--repository owner/name` to
override. The same label scopes repo-level secrets and variables. Values
resolve on the server at dispatch time, so a push uses the server's values.

**4. Developers clone and push.** No `ndh`, no configuration:

```bash
git clone ssh://git@git.internal/srv/git/app.git
git push origin main
```

The push waits for the dispatched run, and the result streams back as
`remote:` lines:

```
remote: | greeting is *** on refs/heads/main
remote: [app-ci / build] Job Completed with Status: Succeeded
remote: [.github/workflows/ci.yml] Workflow 2 Completed with Status: Succeeded
remote: All Workflows finished successfully
remote: [ndh] dispatched main (refs/heads/main)
```

Secret values arrive masked (`***`). The hook dispatches each pushed branch
with `--ref refs/heads/<branch>`, so `on: push: branches:` filters behave
exactly like a GitHub push. Teammates watch results in the web UI with the
`--basic-auth` credentials, or from the CLI:

```bash
ndh status   --server http://hub.internal:4949   # runners + recent runs
ndh projects --server http://hub.internal:4949   # per-project rollup
ndh watch <run-id> --server http://hub.internal:4949
```

CI cannot reject a push, a hub-down push still lands, and each extra repo
gets its own `ndh hook install`. Those details, with verified transcripts,
are in [docs/collaboration.md](docs/collaboration.md); the hook internals are
in [docs/operations.md](docs/operations.md#trigger-ci-from-a-git-server).

---

## Setup 3 — self-hosted GitLab, or any git host

notdownhub runs workflows in **GitHub Actions format**, from
`.github/workflows/`, no matter where the repo is hosted. A repo on GitLab is
no exception: the engine does not read `.gitlab-ci.yml`. Keep workflows in
`.github/workflows/` and any git host works.

The hub has no webhook endpoint for a forge to call
([#115](https://github.com/davidtai/notdownhub/issues/115)). A webhook-shaped
POST is accepted and dropped, and no run starts. Trigger runs through a
checkout dispatch, a server hook, or a mirror — the three patterns below.

### Dispatch from any checkout

The direct path needs no integration at all. Clone from GitLab, then dispatch
the tree to your hub — verified against a local GitLab over HTTP:

```bash
git clone http://gitlab.internal/team/app.git
cd app
ndh dispatch --server http://hub.internal:4949
```

The project label derives from the checkout's `origin` remote. Pass
`--repository owner/name` to set it explicitly.

### GitLab server hooks (self-hosted)

Self-hosted GitLab keeps each project as a bare repo on the GitLab host, and
runs `custom_hooks/post-receive` there after each push. That is the same hook
shape `ndh hook install` writes. The flow below was verified live against
GitLab CE 19.2.1 (Omnibus, in Docker). A push to GitLab dispatched the hub,
and the run streamed back into the push output.

**On the GitLab host**, give `ndh` a home the `git` user can write, and
install the runner stack (Node >= 22.13 first — see
[install.md](docs/install.md)):

```bash
mkdir -p /var/opt/gitlab/ndh-home
export HOME=/var/opt/gitlab/ndh-home
ndh install
chown -R git:git /var/opt/gitlab/ndh-home
```

**As the `git` user**, with the same `HOME`, store the team's values. The
GitLab host is now the dispatching machine — the same rule as Setup 2:

```bash
export HOME=/var/opt/gitlab/ndh-home
ndh secrets backend file
ndh secrets set CI_GREETING          # hidden prompt; or pipe the value
```

**Find the project's disk path** (GitLab hashed storage) and install the
hook. `gitlab-rails` needs a root shell; the rest runs as the `git` user:

```bash
gitlab-rails runner "puts Project.find_by_full_path('team/app').repository.disk_path"
# @hashed/6b/86/6b86b2…5b4b

REPO=/var/opt/gitlab/git-data/repositories/@hashed/6b/86/6b86b2…5b4b.git
mkdir -p "$REPO/hooks" "$REPO/custom_hooks"
ndh hook install "$REPO" --server http://hub.internal:4949 --repository team/app
mv "$REPO/hooks/post-receive" "$REPO/custom_hooks/post-receive"
```

The hashed path gives no usable project slug, so keep the explicit
`--repository`. GitLab passes a minimal environment to a custom hook. Add one
line at the top of `custom_hooks/post-receive`, under `#!/bin/sh`:

```sh
export HOME=/var/opt/gitlab/ndh-home PATH=/usr/bin:/bin:/usr/local/bin:/opt/gitlab/embedded/bin DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
```

- `HOME` points the hook at the ndh state installed above.
- Omnibus git lives in `/opt/gitlab/embedded/bin`, so `PATH` must include it.
- The Omnibus Docker image ships without `libicu`; the invariant-globalization
  flag lets the .NET dispatch client start without it.

A push to GitLab now triggers CI, and the run streams back into the push
output as in Setup 2. Server-side secrets arrive in the run, masked as `***`.
Runs group under the `--repository` label in the UI and in `ndh projects`.

### Push mirroring to a hooked bare repo

Sometimes you cannot place hooks on the GitLab host: gitlab.com, or no shell
access. Mirror the repo to a plain bare git server that carries the Setup 2
hook:

```bash
# on the git server:
git init --bare /srv/git/app-mirror.git
ndh hook install /srv/git/app-mirror.git --server http://hub.internal:4949 --repository team/app
```

Point GitLab push mirroring (Settings → Repository → Mirroring repositories)
at that repo, or push the mirror yourself:

```bash
git push --mirror git.internal:/srv/git/app-mirror.git
```

Verified: a `git push --mirror` from a stand-in GitLab origin fired the hook,
and the run recorded under `team/app`. The generated hook dispatches branch
refs and skips tag refs, so a full mirror push is safe. GitLab's scheduled
push mirroring performs the same push; that half follows GitLab's
documentation and was not run here.

---

## Migrate from a GitHub Actions self-hosted runner

Your workflow files do not change. notdownhub runs the same YAML, the same `runs-on` labels, and the same marketplace actions.

Follow these steps to move a runner machine:

1. Start a hub on a machine that you control: `ndh hub up`.
2. On the runner machine, install notdownhub: `npm install -g notdownhub`.
3. Join the machine to the hub: `ndh runner join http://<hub-host>:4949 --token <token>`.
4. Set the same labels that your workflows request in `runs-on`. Use `--labels` when you join.
5. Start the runner: `ndh runner start`.
6. Store each repository secret with `ndh secrets set <NAME>`, and each variable with `ndh vars set <NAME> <value>`. The hub does not read secrets or variables from GitHub. On a headless or SSH-only macOS account, run `ndh secrets backend file` first.
7. Run your CI from a repository checkout: `ndh dispatch --server http://<hub-host>:4949`.

Facts that apply to a migration:

- A runner registration binds to one server. The same machine can hold a GitHub registration and a notdownhub registration at the same time. Jobs do not cross between the two registrations.
- The first run downloads each action one time through the hub mirror. Later runs read the actions from the mirror cache.
- Webhooks do not reach your hub; it exposes no webhook endpoint. To start CI, use `ndh dispatch`, a `post-receive` hook on your git server (`ndh hook install`), or an `on: schedule` trigger. The [operations guide](docs/operations.md) describes each trigger.
- The hub stores artifacts and cache data from `actions/upload-artifact` and `actions/cache`.
- Secrets and variables are stored on the machine you dispatch from, and inject into each run. See [operations.md → Secrets & variables](docs/operations.md#secrets--variables) for scopes, multiline secrets, and how values reach a run.

---

## GitHub Marketplace actions

Your workflows can use Marketplace actions with the standard `uses:` syntax.
The hub downloads each action from GitHub one time, through its caching
mirror. Every later run reads the action from the cache. The actions then
execute on the official runner codebase, so they behave as they do on GitHub.
`actions/checkout` is the one substitution: for a dispatched local repo, the
hub serves its own checkout action with the same `checkout@v4` inputs.

Verified on this fleet: `actions/checkout`, `actions/setup-node`,
`pnpm/action-setup`, `actions/cache`, and `actions/upload-artifact`.

Three limits apply:

1. The first fetch of each action needs a connection to GitHub. After that
   fetch, the mirror serves the action offline.
2. Actions that call the GitHub API at run time need a connection and a
   `GITHUB_TOKEN` secret. Examples: `actions/github-script` and release
   publishers. The mirror cannot answer API calls.
3. Docker container actions (`uses: docker://…` and Dockerfile actions) need
   Docker on the runner. We have not yet verified them on this fleet.

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

`ndh run` needs none of this — it starts a hub and a runner in-process, runs
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

`node packages/cli/dist/index.js` *is* `ndh`. Put it on your `PATH`:

```bash
mkdir -p ~/bin && ln -s "$PWD/packages/cli/dist/index.js" ~/bin/ndh
export PATH="$HOME/bin:$PATH"     # add this line to your shell profile
```

Every `ndh …` command in these docs then works verbatim. A shell alias works
for interactive commands only — git hooks do not read aliases. Full per-OS
build prerequisites are in [docs/install.md](docs/install.md#from-source).

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
