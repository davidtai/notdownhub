# notdownhub

**GitHub can be down; your CI isn't.**

`ndh` runs your **unmodified** GitHub Actions workflows on infrastructure you
control — your laptop, one box under a desk, or a fleet of machines behind
NAT. Same YAML, same `runs-on`, same `actions/checkout@v4`, same matrix and
`needs:` graph. No re-implemented engine, no forge to stand up, no GitHub
Enterprise invoice. After the first run it works fully offline.

notdownhub is a thin product wrapper (the `ndh` CLI) around
[`ChristopherHX/runner.server`](https://github.com/ChristopherHX/runner.server)
— a maintained, MIT-licensed fork of GitHub's official
[`actions/runner`](https://github.com/actions/runner) that adds an
Actions-protocol server and client. Because execution rides on the official
runner codebase, workflows run with full fidelity rather than a best-effort
approximation.

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

`ndh` is for the case in between "just run it on my laptop" and "adopt a whole
forge": run the CI you already have, locally or across your own machines, with
nothing pointing at github.com.

---

## 60-second quickstart

**Requirements:** Node.js >= 20 to *run* `ndh`. Building from source needs
Node >= 22.13 (the repo pins pnpm 11). macOS / Linux / Windows on x64 or arm64.

notdownhub isn't published to npm yet, so today the way in is clone + build
(the CLI's bin is `ndh`):

```bash
git clone https://github.com/OpenSourceWTF/notdownhub.com
cd notdownhub.com
pnpm install && pnpm -r build
node packages/cli/dist/index.js install   # one-time: downloads the pinned runner stack (~66 MB)
node packages/cli/dist/index.js run       # run this repo's workflows locally, one-shot
```

`node packages/cli/dist/index.js` *is* `ndh`; symlink or alias it
(`alias ndh="node $PWD/packages/cli/dist/index.js"`) and the rest of this
README's `ndh …` commands work verbatim.

**Once published to npm**, you'll also be able to run it with no clone:

```bash
pnpm dlx notdownhub install     # or: npx notdownhub install
pnpm dlx notdownhub run         # or: npx notdownhub run
```

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

By default `ubuntu-*` jobs run in a Linux container (`catthehacker/ubuntu:act-latest`)
if Docker is available, and on the host machine otherwise; `macos-latest`,
`windows-latest`, and `self-hosted` always run on the host. Override any
mapping with `-P`, e.g. `-P ubuntu-latest=-self-hosted`.

---

## Fleet quickstart

Stand up a persistent coordination hub, then attach runners from anywhere —
even across NAT (runners are outbound-only long-pollers).

**On the hub machine:**

```bash
ndh hub up                       # one public port (default 4949)
```

This starts the web UI + API + runner coordination + action mirror behind a
single port, prints a **runner registration token**, and stores it at
`~/.notdownhub/hub/runner-token`. State (runners, runs) persists in SQLite at
`~/.notdownhub/hub/hub.db` across restarts.

```
[ndh] hub up on http://localhost:4949  (ui: yes, auth: on, mirror: on)
[ndh] runner registration token: 8f3c…
[ndh] join a runner:   ndh runner join http://<this-host>:4949 --token 8f3c…
[ndh] dispatch a repo: ndh dispatch --server http://<this-host>:4949
```

Useful `hub up` flags:

- `--port <n>` — public port (default 4949).
- `--host <name-or-ip>` — the address the hub advertises to runners for the
  action mirror. Defaults to the machine's auto-detected primary LAN IPv4 so
  that *remote* runners can actually reach the mirror (they can't reach the
  hub's `127.0.0.1`). Override it when the primary NIC guess is wrong or you
  want runners to use a stable name — e.g. a DNS name (`--host hub.internal`)
  or a tailnet address (`--host hub.tailnet`).
- `--github-token <pat>` — give the server a PAT.
- `--no-auth` — disable registration-token auth (open registration).
- `--no-mirror-rewrite` — don't route `uses:` through the mirror.
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
what's joined.

**From any repo you want built by the fleet:**

```bash
ndh dispatch --server http://hub.tailnet:4949 --event push
ndh status  --server http://hub.tailnet:4949      # runners + recent runs
```

> **Auth note:** `ndh runner join` defaults `--token` to the literal
> `notdownhub`, which will **not** match a hub's random registration token. On
> an auth-on hub always pass the real `--token` the hub printed. The default is
> only useful against a hub started with `--no-auth`.

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

## Honest caveats (v0.1)

- **The hub API and UI are unauthenticated in v0.1.** Only *runner
  registration* is token-gated. Treat the hub as a LAN / tailnet tool; don't
  expose port 4949 to the public internet.
- **Unmodified *official* `actions/runner` binaries can only join a hub on
  `:443` over TLS.** The official runner drops non-standard ports during
  registration (verified with `actions/runner` v2.336.0). The **bundled fork's**
  listener (what `ndh runner join` uses) has no such limit, so any port works
  for `ndh` runners. See the port-443 finding in the architecture doc.
- **A runner registration binds to exactly one server.** The same machine can
  hold an `ndh`-hub-pointed runner *and* a github.com-pointed runner side by
  side, but there is no cross-dispatch between them (see issues #5, #6).
- This is v0.1. Interfaces and defaults may change.

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

## Developing notdownhub

This repo eats its own dog food: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs the same on github.com and locally with `ndh`. It runs locally with
`ndh run`; on a machine without Docker, map `ubuntu-latest` to the host:

```bash
ndh run -W .github/workflows/ci.yml -P ubuntu-latest=-self-hosted
```

Verified end-to-end on a macOS/arm64 host (no Docker): checkout → pnpm/Node 22
setup → `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm -r test` all
pass.
