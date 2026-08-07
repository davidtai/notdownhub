# Installing notdownhub

This guide covers every supported way to install `ndh`. It explains what
`ndh install` downloads and where the files live. It also covers the Docker
fleet-runner image and how to verify an install. For hub and fleet operation,
see [operations.md](operations.md).

Everything below was exercised against the current `main` build on macOS/arm64;
command output snippets are real (host/token/paths abbreviated).

---

## 1. Prerequisites

| Need | Version / notes |
|---|---|
| **Node.js** | **>= 22.13** (the CLI's `engines.node`; the repo's pnpm 11 needs the same). Both running and building `ndh` require it. |
| **pnpm** | 11.x, via `corepack` (ships with Node) — `corepack enable`. Only needed to build from source. |
| **git** | to clone the repo (and used by `actions/checkout` inside workflows). |
| **tar** | to extract the runner bundle. macOS bsdtar and Linux GNU tar both work; `ndh` shells out to `tar -xzf`. |
| **Docker** | **optional.** Adds two things: (1) `ndh run` executes `ubuntu-*` jobs in a Linux container instead of on the host; (2) the fleet [Docker runner image](#4-docker-fleet-runner-image). Without Docker, `ubuntu-*` maps to the host machine. |

Platforms: macOS, Linux, Windows on x64 or arm64. The runner bundle is fetched
per-platform (`osx-arm64`, `osx-x64`, `linux-arm64`, `linux-x64`, `win-arm64`,
`win-x64`).

### Per-OS setup

**macOS**

`ndh` needs the Xcode command-line tools, Node >= 22.13, and `corepack`:

```bash
xcode-select --install          # git + build tools (if not already present)
```

With admin rights, install Node from Homebrew:

```bash
brew install node
corepack enable
```

Without admin rights (no Homebrew, `/opt/homebrew` not writable), install Node
into `$HOME`. Use nvm, or unpack the official tarball:

```bash
# option A — nvm (user-level, no admin):
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22

# option B — official tarball into $HOME (arm64 shown; use x64 on Intel Macs):
curl -fsSLO https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz
tar -xzf node-v22.14.0-darwin-arm64.tar.gz -C "$HOME"
export PATH="$HOME/node-v22.14.0-darwin-arm64/bin:$PATH"   # add this to ~/.zshrc
corepack enable
```

**Linux (Debian/Ubuntu)**

```bash
sudo apt-get update
sudo apt-get install -y git tar ca-certificates curl
# Node >= 22.13 (NodeSource or nvm); then:
corepack enable
```

**Windows**

Install the Node.js >= 22.13 MSI and [Git for Windows](https://git-scm.com/download/win),
then run `corepack enable` in an elevated shell. `ndh` resolves the `win-<arch>`
bundle and appends `.exe` to the binaries automatically. The launchd/systemd
service examples in [operations.md](operations.md) are macOS/Linux only.

**corepack on a fresh Node 22.13**

A fresh Node 22.13.x ships an old `corepack` (0.30.0) with stale signature keys.
On that version `corepack enable` then `pnpm install` fails with
`Cannot find matching keyid`. Update corepack first, then continue:

```bash
npm install -g corepack@latest      # -> corepack >= 0.35
corepack enable
```

Node >= 22.14 ships a current corepack, so this step is only for Node 22.13.x.

---

## 2. Install from npm

The published package is `notdownhub`; its `bin` is `ndh` (see
`packages/cli/package.json`). Install it globally:

```bash
npm install -g notdownhub      # or: pnpm add -g notdownhub
ndh --version
# 0.0.1
```

That puts `ndh` on your `PATH`. Or run it without a global install, one-shot:

```bash
pnpm dlx notdownhub run        # or: npx notdownhub run
pnpm dlx notdownhub install    # warm the runner stack ahead of time
```

Both forms are identical to `ndh …`; the rest of these docs use `ndh`.

### From source

Contributors, or anyone running an unreleased build, clone and build instead:

```bash
git clone https://github.com/davidtai/notdownhub
cd notdownhub
pnpm install
pnpm -r build
```

`pnpm -r build` compiles the CLI to `packages/cli/dist/`. The entry point
`packages/cli/dist/index.js` **is** `ndh` — alias it so the docs work verbatim:

```bash
alias ndh="node $PWD/packages/cli/dist/index.js"
ndh --version
# 0.0.1
```

(Or symlink it onto your `PATH`:
`ln -s "$PWD/packages/cli/dist/index.js" /usr/local/bin/ndh` — the file already
has a `#!/usr/bin/env node` shebang and is marked executable by the build.)

---

## 3. `ndh install` — the runner stack

`ndh` is a thin wrapper; the actual Actions engine is the pinned
[`ChristopherHX/runner.server`](https://github.com/ChristopherHX/runner.server)
bundle (server + client + runner in one archive). `ndh install` downloads and
extracts it. Most commands call this automatically on first use, but running it
explicitly makes the one-time ~66 MB download obvious.

```bash
ndh install
# [ndh] downloading runner.server 3.14.0 (osx-arm64) ...
# [ndh] extracting to /Users/you/.notdownhub/vendor/runner.server-3.14.0 ...
# [ndh] vendor stack ready
```

Run it again and it is a no-op (prints nothing, exits 0) because a completion
marker already exists:

```bash
ndh install ; echo "exit=$?"
# exit=0
```

### What is downloaded and pinned

- **Version:** `runner.server` **v3.14.0**, hard-pinned in
  `packages/cli/src/lib.ts` (`VENDOR_VERSION`). Upgrading it is a code change
  (see [operations.md → Upgrading](operations.md#upgrading-the-runner-stack)).
- **Source URL:**
  `https://github.com/ChristopherHX/runner.server/releases/download/v3.14.0/runner.server-<rid>.tar.gz`
  where `<rid>` is your platform id (e.g. `osx-arm64`). The archive is ~66 MB.
- **Pinning / integrity:** pinning is by exact version tag + fixed release URL.
  **There is no separate checksum verification step in v0.1** — the download is
  trusted over TLS from GitHub Releases. If you need stronger supply-chain
  guarantees, host the archive yourself and point `NDH_VENDOR_URL` at it (below);
  you can verify that copy out of band.

### `NDH_HOME` layout

Everything `ndh` stores lives under `NDH_HOME` (default `~/.notdownhub`;
override by exporting `NDH_HOME=/some/path`). After installing and running a hub
+ runner, the tree looks like:

| Path | Contents | Disposable? |
|---|---|---|
| `vendor/runner.server-3.14.0/` | extracted bundle: `Runner.Server`, `Runner.Client`, `Runner.Listener`, plus a `.ndh-complete` marker | **Yes** — recreate with `ndh install` |
| `cache/runner.server-<rid>-3.14.0.tar.gz` | the downloaded archive (kept so re-extract is offline) | **Yes** |
| `hub/hub.db` (+ `-wal`, `-shm`) | SQLite: registered runners + workflow runs | **Back up** — this is your fleet state |
| `hub/runner-token` | registration token, mode `0600` | **Back up** — it is a secret |
| `hub/logs/`, `runners/<name>/logs/`, `logs/` | daily-rotated `0600` logs (hub / runner / one-shot run+dispatch) | **Yes** — auto-pruned (14-day default) |
| `runners/<name>/` | per-runner instance: `bin/` (a bundle copy) + `.runner` + `.credentials` + `.credentials_rsaparams` (the runner's private key, `0600`) + `_work/` + `_diag/` | Recreatable via `ndh runner join` |
| `mirror/<owner>/<repo>/<kind>-<ref>.tgz` | cached action archives | Disposable online; **back up for offline** |
| `secrets-index.json`, `secrets.json`, `secrets.key` | `ndh secrets` store (file backend; macOS uses the Keychain instead) — see below | `secrets.json`/`.key` are **secret** |

> This is the common subset. The **exhaustive** inventory is in
> **[docs/files.md](files.md)**. It also lists files written *outside*
> `NDH_HOME`: ASP.NET DataProtection keys in `~/.aspnet`, ephemeral secret files
> in `$TMPDIR/ndh-secrets`, and macOS Keychain entries. Each entry gives purpose,
> sensitivity, and safe-to-delete guidance.

On a headless or SSH-only macOS account, the login Keychain is often locked, and
`ndh secrets set` fails with "Unable to obtain authorization". Run
`ndh secrets backend file` first to store secrets in the encrypted file backend.

### `--force`, proxies, and tokens

- **`ndh install --force`** re-downloads and re-extracts even if the marker
  exists — use it if the bundle got corrupted or you changed `NDH_VENDOR_URL`.
- **`NDH_VENDOR_URL`** overrides the download URL entirely (internal mirror,
  air-gapped artifact server, a locally verified copy). Point it at a
  `runner.server-<rid>.tar.gz` you control.
- **Proxies:** the download uses Node's built-in `fetch`. Some Node versions
  honor proxy environment variables and use them. Behind a restrictive proxy,
  the reliable method is to pre-place the archive and set `NDH_VENDOR_URL`. You
  can also drop the archive into `cache/` with the exact filename above.
- **`GITHUB_TOKEN`** does **not** affect this download (GitHub Releases assets
  are anonymous and high-limit). It matters only for the hub's action *mirror*
  (see [operations.md → Mirror](operations.md#mirror-operations)).

---

## 4. Docker fleet-runner image

`docker/runner/` builds a container that joins a hub and executes jobs — ideal
for adding disposable Linux capacity to a fleet. The image is `node:22-bookworm`
with `git`, `curl`, `jq`, `unzip`, `corepack` enabled, and the pinned
`runner.server` linux bundle baked in at build time.

### Build

```bash
docker build -t ndh-runner docker/runner
```

The `RUNNER_SERVER_VERSION` build arg (default `3.14.0`) selects the bundle;
the correct `arm64`/`amd64` archive is chosen from `dpkg --print-architecture`.

### Run

```bash
docker run -d --restart unless-stopped --name ndh-runner-1 \
  -e NDH_HUB_URL=http://hub-host:4949 \
  -e NDH_TOKEN=<registration-token> \
  -e NDH_NAME=docker-runner-1 \
  -e NDH_LABELS=self-hosted,linux,ARM64,docker \
  ndh-runner
```

Environment variables (from `docker/runner/entrypoint.sh`):

| Var | Required | Default | Meaning |
|---|---|---|---|
| `NDH_HUB_URL` | **Yes** | — | Hub base URL, e.g. `http://hub-host:4949`. `/runner/server` is appended automatically. |
| `NDH_TOKEN` | No | `notdownhub` | Registration token. **Must** be the hub's real token unless the hub runs `--no-auth`. |
| `NDH_NAME` | No | `docker-$(hostname)` | Runner name shown in `ndh status`. |
| `NDH_LABELS` | No | `self-hosted,linux,docker` | Labels the runner advertises; jobs match these against `runs-on`. |

`--restart unless-stopped` gives you crash/reboot recovery. The runner
registers with `--replace`, so re-running with the same `NDH_NAME` cleanly takes
over that identity.

**Persisting registration:** the entrypoint writes `.runner`/`.credentials` to
`/home/runner/ndh` and only re-configures if `.runner` is absent. To survive
`docker rm` without re-registering, mount a volume there:

```bash
docker run -d --restart unless-stopped \
  -v ndh-runner-1-state:/home/runner/ndh \
  -e NDH_HUB_URL=http://hub-host:4949 -e NDH_TOKEN=<token> \
  ndh-runner
```

### Updating the image

```bash
docker build -t ndh-runner docker/runner            # rebuild (optionally --build-arg RUNNER_SERVER_VERSION=X)
docker rm -f ndh-runner-1                            # stop the old container
docker run -d --restart unless-stopped --name ndh-runner-1 ... ndh-runner   # start the new one
```

With a state volume the new container reuses the existing registration; without
one it re-registers (harmless thanks to `--replace`).

---

## 5. Verifying an install

These need no hub:

```bash
ndh --version
# 0.0.1

ndh install ; echo "exit=$?"        # ensures the bundle is present
# exit=0
```

The next two use the sample repo in [`examples/demo`](https://github.com/davidtai/notdownhub/tree/main/examples/demo),
so run them from a clone (or any repo with workflows):

```bash
# Parse a real workflow with the actual engine (lists jobs, runs nothing):
ndh run -W examples/demo/.github/workflows/ci.yml -l
```

Expected tail — the engine has parsed the matrix + `needs:` graph:

```
| Found 2 matching jobs for the requested event push
| build
| report depends on build
```

Full end-to-end (this actually executes). Without Docker, `ndh run` maps
`ubuntu-latest` to the host, so no `-P` flag is needed:

```bash
cd examples/demo
ndh run
# ... three `build` matrix legs run, then:
# report: build says: 'hello-from-…'
```

Success looks like every step reporting `Succeeded` and the workflow finishing
`Completed with Status: Succeeded`. If it fails, jump to
[operations.md → Troubleshooting](operations.md#troubleshooting).
