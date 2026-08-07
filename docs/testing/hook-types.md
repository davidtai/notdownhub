# Manual testing report: hook types (#120)

This report records the live verification of `ndh hook install --type`.
Every command below was run as written. The output lines are verbatim.

## Environment

- Date: 2026-08-07. Platform: macOS (Darwin 25.5.0), zsh, POSIX `sh` hooks.
- Build: branch `feat/hook-types` on top of main commit `4348910`.
  The CLI ran from `packages/cli/dist` through an `ndh` shim on `PATH`.
- Hub: `ndh hub up --port 6419 --hub-port 6420 --host 127.0.0.1`.
- Runner: `ndh runner join http://127.0.0.1:6419 --name sb120 --labels self-hosted --token <token>`, then `ndh runner start sb120`.
  `ndh status` showed `sb120 [self-hosted,macOS,ARM64] online, idle`.
- Isolation: throwaway `NDH_HOME` from `mktemp -d`, `NDH_SECRETS_BACKEND=file`,
  vendor bundle copied (not symlinked) from an existing install.
- `$SB` below is the sandbox root, a session temp directory.
- Repos: bare `$SB/git/team/app.git` (post-receive), bare `$SB/git/team/gated.git`
  (pre-receive), clone `$SB/client` (pre-push), checkout `$SB/commit-repo`
  (post-commit), checkouts `$SB/work` and `$SB/work2` as pushers.
- Workflows: one job on `runs-on: self-hosted` with `on: push: branches:`
  filters, made to pass (`echo ok`) or fail (`exit 1`) per scenario.

## post-receive (server, default)

Installed with:

```bash
ndh hook install $SB/git/team/app.git --server http://127.0.0.1:6419
```

| Scenario | Command | Observed | Verdict |
|---|---|---|---|
| Push a tracked branch | `git push origin main` | Run streams into the push; `All Workflows finished successfully`; `[ndh] dispatched main (refs/heads/main)`; exit 0 | pass |
| Failed workflow cannot reject | see hub history | Run `#11 app-ci completed/failed`; the push still landed | pass |
| Tag push | `git tag v9 && git push origin v9` | Zero `[ndh] dispatched` lines; exit 0 | pass |
| Branch delete | `git push origin :tmpbr` | ` - [deleted] tmpbr`; no dispatch, no error; exit 0 | pass |

The hub recorded run `#1 app-ci [team/app] completed/succeeded (push) ... on sb120`.

## pre-receive (server, CI-gated push)

Installed with:

```bash
ndh hook install $SB/git/team/gated.git --type pre-receive --server http://127.0.0.1:6419
```

| Scenario | Command | Observed | Verdict |
|---|---|---|---|
| Failing workflow rejects | `git push origin main` (workflow has `exit 1`) | Push exit 1; ref not created (`git ls-remote` empty); output below | pass |
| Passing workflow accepts | `git push origin main` (workflow fixed) | `[ndh] CI passed for main — branch gate passed`; `27b875b..b77abeb main -> main`; exit 0 | pass |
| Filter skip accepts | `git push origin feature2` (untracked branch) | `All Workflows skipped, due to filters`; `[ndh] workflows skipped by filters for feature2 — branch gate passed`; `* [new branch] feature2 -> feature2`; exit 0 | pass |
| Multi-ref all-or-nothing | `git push origin main dev` (main passes, dev fails) | Both refs rejected; `main` did not move; output below | pass |
| Tag push not gated | `git push origin v1` | `* [new tag] v1 -> v1`; no dispatch; exit 0 | pass |
| Branch delete not gated | `git push origin :feature/logging` | ` - [deleted] feature/logging`; no dispatch; exit 0 | pass |
| Hub down fails closed | push to a gate that points at a dead port | Push exit 1; rejection with a clear cause; output below | pass |

What the pushing developer sees on a rejection:

```text
remote: [gated-ci / build] Job Completed with Status: Failed
remote: [.github/workflows/ci.yml] Workflow 2 Completed with Status: Failed
remote: [ndh] CI failed for main (exit 1) — push rejected
remote: [ndh]   [gated-ci / build] Job Completed with Status: Failed
remote: [ndh]   [.github/workflows/ci.yml] Workflow 2 Completed with Status: Failed
 ! [remote rejected] main -> main (pre-receive hook declined)
```

The multi-ref push (git applies one verdict to all refs):

```text
remote: [ndh] CI passed for main — branch gate passed
remote: [ndh] CI failed for dev (exit 1) — push rejected
 ! [remote rejected] main -> main (pre-receive hook declined)
 ! [remote rejected] dev -> dev (pre-receive hook declined)
```

The unreachable hub (`--server http://127.0.0.1:6421`, nothing listening):

```text
remote: [ndh] can't reach the hub at http://127.0.0.1:6421 — is it up? (ndh hub up) and is --server correct?
remote: [ndh]   connect ECONNREFUSED 127.0.0.1:6421
remote: [ndh] CI failed for main (exit 1) — push rejected
 ! [remote rejected] main -> main (pre-receive hook declined)
```

The first rejected push also found a real bug. The initial template used
`git checkout`, and git answered
`fatal: update_ref failed for ref 'HEAD': ref updates forbidden inside quarantine environment`.
The template now uses `git archive`, which only reads objects.

## pre-push (client)

Installed in a clone of `team/app.git`:

```bash
cd $SB/client && ndh hook install . --type pre-push
```

The install derived `repository: team/app` from the origin remote.

| Scenario | Command | Observed | Verdict |
|---|---|---|---|
| Failing CI blocks (local mode) | `git push origin main` (workflow has `exit 1`) | `[ndh] CI failed for main (exit 1) — push blocked`, plus the failed job lines; `error: failed to push some refs`; exit 1 | pass |
| Passing CI allows (local mode) | `git push origin main` (workflow fixed) | `[ndh] CI passed for main — branch gate passed`; `7e734b6..af59112 main -> main`; exit 0 | pass |
| Nothing to push | `git push origin main` again | `Everything up-to-date`; no CI run; exit 0 | pass |
| Untracked branch skip | `git push origin scratch` | `All Workflows skipped, due to filters`; `[ndh] workflows skipped by filters for scratch — branch gate passed`; exit 0 | pass |
| Branch delete | `git push origin :scratch` | ` - [deleted] scratch`; no CI run; exit 0 | pass |
| `--server` dispatch mode blocks | reinstall with `--server http://127.0.0.1:6419`, push failing CI | Hub run `#11` failed; `[ndh] CI failed for main (exit 1) — push blocked`; exit 1 | pass |

## post-commit (client, advisory)

Installed with:

```bash
cd $SB/commit-repo && ndh hook install . --type post-commit
```

| Scenario | Command | Observed | Verdict |
|---|---|---|---|
| Passing commit | `git commit -m "passing commit"` | `[ndh] advisory CI passed for commit d52a26e`; commit exit 0 | pass |
| Failing CI never blocks | `git commit -am "breaking commit"` | `[ndh] advisory CI FAILED for commit bb63ea3 (exit 1) — the commit itself stands`; commit exit 0; HEAD advanced | pass |
| Amend fires again | `git commit --amend --no-edit` | Same advisory FAILED line for the new sha `851f27a`; exit 0 | pass |
| Merge commit fires | `git merge --no-ff -m "merge topic" topic` | `[ndh] advisory CI passed for commit cd532eb`; exit 0 | pass |

Consecutive commits cannot pile up in one terminal. Each `git commit` waits
for its advisory run to finish before it returns.

## Not covered / known limits

- A multi-branch push through post-receive was not exercised live.
  An executed-hook unit test covers it (two dispatches, tag and delete skipped).
- The engine's exact exit code for "all workflows skipped" is not pinned.
  The gate accepts a proven skip at any exit code, and that is by design.
- `core.hooksPath` and linked work-trees were not exercised live.
  The install resolves `git rev-parse --git-path hooks`, covered by unit tests.
- post-commit with `--server` was not exercised live; unit tests cover the
  generated dispatch invocation.
- pre-push tests only the tip commit of each pushed branch, not every
  intermediate commit. This is the documented contract.
- Concurrent pushes from several clients were not load-tested.
- Windows was not tested. The generated hooks are POSIX `sh`.
