# Generated files reference

Every file and directory `ndh` — or the `runner.server` binaries it launches —
creates, where it lives, what it holds, how sensitive it is, and whether it's
safe to delete. Verified empirically by running a hub, a runner, a fleet
dispatch, and `ndh secrets` against a scratch `NDH_HOME` and inspecting the
result.

**Sensitivity legend:** **secret** = protect like a credential · **state** =
operational data worth keeping/backing up · **disposable** = regenerated on
demand.

`NDH_HOME` defaults to `~/.notdownhub` (override with the `NDH_HOME` env var).
Sizes/paths below use the defaults.

---

## Inside `NDH_HOME`

### Runner stack (from `ndh install`)

| Path | Purpose | Sensitivity | Safe to delete? |
|---|---|---|---|
| `vendor/runner.server-3.14.0/` | Extracted bundle: `Runner.Server`, `Runner.Client`, `Runner.Listener` + all their `.dll`s, plus a `.ndh-complete` marker. | disposable | Yes — `ndh install` recreates it. |
| `cache/runner.server-<rid>-3.14.0.tar.gz` | The downloaded ~66 MB archive, kept so re-extraction is offline. | disposable | Yes. |

### Hub (`ndh hub up`)

`Runner.Server` runs with its working directory set to `hub/`, so what it writes
lands here.

| Path | Purpose | Sensitivity | Safe to delete? |
|---|---|---|---|
| `hub/hub.db`, `hub/hub.db-wal`, `hub/hub.db-shm` | SQLite: registered runners + workflow-run history. The `-wal`/`-shm` are the write-ahead log and shared-memory index. | **state** | Only with the hub stopped, and you lose the fleet + run history (runners must re-join). Back these up together. |
| `hub/runner-token` (mode `0600`) | The runner registration token. Anyone holding it can register runners. | **secret** | Deleting makes the next `hub up` mint a new token — every runner must then re-join. |
| `hub/logs/hub-YYYY-MM-DD.log` (file `0600`, dir `0700`) | Daily hub log: `[ndh]` lines **and** teed `Runner.Server` output, ANSI-stripped. | state (diagnostic) | Yes — old days are auto-pruned (14-day default) anyway. |

> Empirically, for a simple fleet job the hub working dir held **only** the
> `hub.db*`, `logs/`, and `runner-token` above — no artifact/cache storage
> directory was created. `Runner.Server` materializes artifact/cache storage
> under its working dir **only when a workflow actually uses**
> `actions/upload-artifact` / `actions/cache`; treat any such directory that
> appears under `hub/` as disposable per-run storage.

### Runners (`ndh runner join` / `start`)

One directory per runner under `runners/<name>/`:

| Path | Purpose | Sensitivity | Safe to delete? |
|---|---|---|---|
| `runners/<name>/.runner` (`0644`) | Runner config: name, labels, pool, server URL. | state | Yes, but you must re-`join` to run again. |
| `runners/<name>/.credentials` (`0644`) | Credential **metadata** (auth scheme, client id) — points at the key file below; not the key itself. | state | Delete only alongside a re-join. |
| `runners/<name>/.credentials_rsaparams` (`0600`) | The runner's **RSA private key** used to authenticate to the hub. | **secret** | No — losing/leaking it means re-join (and the old registration should be replaced). |
| `runners/<name>/bin/` | A copy of the runner bundle (+ `.ndh-complete`) — the listener runs from here. | disposable | Yes — `ndh runner join` re-copies it. |
| `runners/<name>/_work/` | Per-job workspaces: `_PipelineMapping/`, `_temp/`, `_tool/` (hosted-tool cache), and `<repo>/<repo>/` checkouts. Can grow large. | disposable | Yes, between jobs — it's rebuilt per run. |
| `runners/<name>/_diag/` | Runner/worker diagnostic logs (`Runner_*.log`, `Worker_*.log`, `blocks/`, `pages/`). | state (diagnostic) | Yes. |
| `runners/<name>/logs/runner-YYYY-MM-DD.log` (`0600`, dir `0700`) | The `ndh runner start` daily tee log (ndh lines + listener output). | state (diagnostic) | Yes — auto-pruned. |

### Mirror, one-shot logs, and secrets store

| Path | Purpose | Sensitivity | Safe to delete? |
|---|---|---|---|
| `mirror/<owner>/<repo>/<kind>-<ref>.tgz` | Cached action archives (the offline cache). | disposable online; **state for offline** | Yes online (re-fetched); keep it for air-gapped use. |
| `logs/run-YYYY-MM-DD.log`, `logs/dispatch-YYYY-MM-DD.log` (`0600`, dir `0700`) | Daily tee logs for `ndh run` / `ndh dispatch` one-shots. | state (diagnostic) | Yes — auto-pruned. |
| `secrets-index.json` (`0600`) | Index of secret **names + scopes** for `ndh secrets` — never contains values. | state (reveals names) | Deleting desyncs `ndh secrets list` from the actual store. |
| `secrets.json` (`0600`) | **File backend only** (non-macOS, or `NDH_SECRETS_BACKEND=file`): secret values encrypted with AES-256-GCM. | **secret** | Deleting loses those secrets. |
| `secrets.key` (`0600`) | **File backend only**: the 32-byte AES key for `secrets.json`. Co-located with the ciphertext, so this backend is *obfuscation-at-rest* — whoever reads both reads the secrets. | **secret** | Delete only with `secrets.json` (one is useless without the other). |

On macOS the default secrets backend is the **Keychain** (below), so
`secrets.json`/`secrets.key` are **not** created there.

---

## Outside `NDH_HOME`

These are easy to miss because they don't live under `~/.notdownhub`.

| Path | Created by | Purpose | Sensitivity | Safe to delete? |
|---|---|---|---|---|
| `~/.aspnet/DataProtection-Keys/key-*.xml` | `Runner.Server` (ASP.NET Core) | Data-protection keyring used to protect server-side payloads (tokens/cookies). Written to the **user home**, not `NDH_HOME`. | **secret / state** | Regenerated if missing; deleting invalidates anything previously protected with it (fine to reset for a dev hub). |
| `$TMPDIR/ndh-secrets/secrets-<hex>.env` (file `0600`, dir `0700`) | `ndh run` / `ndh dispatch` when secrets exist | Ephemeral GitHub-`GITHUB_ENV`-syntax secret file handed to `Runner.Client` via `--secret-file`. **Zeroed (shredded) and unlinked at the end of every run** — only the path, never values, touches argv/logs. | **secret** (transient) | The `ndh-secrets/` dir persists (empty) and is safe to delete; you should never see a leftover `*.env` (a stray one means a crashed run — delete it). `$TMPDIR` is `/var/folders/.../T` on macOS, `/tmp` on Linux. |
| macOS **Keychain** generic-password items | `ndh secrets set` (macOS default) | The real secret store on macOS. **Service** = `notdownhub:<scope>` (`<scope>` = `global` or `owner/name`), **account** = the secret name, value = the secret. Override the service prefix with `NDH_KEYCHAIN_SERVICE`. | **secret** | Manage with `ndh secrets rm` (or Keychain Access / `security delete-generic-password -s notdownhub:<scope> -a <name>`). |

---

## Quick "what do I back up vs. wipe?"

- **Back up:** `hub/hub.db*` + `hub/runner-token` (fleet + token), your secrets
  store (macOS Keychain, or `secrets.json` **and** `secrets.key`), and `mirror/`
  if you need offline. `runners/<name>/.credentials_rsaparams` if you want a
  runner to keep its identity without re-joining.
- **Safe to wipe anytime:** `vendor/`, `cache/`, every `logs/` and `_diag/`
  directory, and `runners/<name>/_work/`. Also `~/.aspnet/DataProtection-Keys`
  for a throwaway/dev hub.
- **Never appears if healthy:** a leftover `$TMPDIR/ndh-secrets/*.env` — it's
  shredded after each run.

See [install.md](install.md) for the install-time subset of this tree and
[operations.md](operations.md) for backup procedure and the security model.
