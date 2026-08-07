# Solo and team workflows

How one person runs CI on a plain local git repository, and how a team shares
one hub through a git server. Every command below was run live against the
current `main` build. The verification hub ran on test ports 6309/6310; the
text shows the default port 4949 and generalized hosts and paths. Output
snippets are real.

For install steps, see [install.md](install.md). For hub operation, see
[operations.md](operations.md).

---

## Solo: one repo, one machine

A plain local git repository needs no hub, no git server, and no remote.
`ndh run` starts an in-process hub and runner, executes the repo's workflows,
and exits:

```bash
cd ~/src/app
ndh run                              # all workflows, `push` event
ndh run -W .github/workflows/ci.yml  # one workflow file
ndh run -l                           # list the jobs, run nothing
```

The run executes your checked-out working tree, with your uncommitted changes.
A repository without an `origin` remote works; its runs are labeled
`local/<dirname>`. The full flag set and the platform mappings are in the
[README quickstart](../README.md#60-second-quickstart).

Secrets and variables for solo runs live on the same machine:

```bash
ndh secrets set CI_GREETING          # hidden prompt; or pipe the value
ndh vars set DEPLOY_TARGET staging
```

The workflow reads them as `${{ secrets.CI_GREETING }}` and
`${{ vars.DEPLOY_TARGET }}`. See
[operations.md → Secrets & variables](operations.md#secrets--variables).

When one machine is not enough, start a persistent hub and attach runners
(the [fleet quickstart](../README.md#fleet-quickstart)). You then trade
`ndh run` for `ndh dispatch --server <hub>` from the same checkout. Your
secrets still live on your machine, because you are the dispatching machine —
the concept the whole team story below turns on.

---

## Team: a shared git server

### The git server is the dispatching machine

One sentence explains where every piece lives: **the git server is the
dispatching machine.**

- `ndh` is installed on the git server, next to the bare repos.
- The `post-receive` hook runs `ndh dispatch` on the server, once per pushed
  branch.
- Secrets and variables are stored in the git server's account, because values
  resolve on the machine that dispatches
  ([how values reach a run](operations.md#how-values-reach-a-run)).
- The hub and the runner fleet can be anywhere the git server can reach on
  port 4949.
- A developer laptop needs only `git`. Teammates push; the server dispatches;
  the fleet builds.

### Topology

```
developer laptops             git server                       hub machine
(need only git)               (ndh + hook + secrets)           (ndh hub up)
+-----------+   git push   +----------------------+  ndh dispatch  +-----------------+
|   dev A   | -----------> | /srv/git/app.git     | -------------> | :4949  UI + API |
|   dev B   | -----------> |  hooks/post-receive  |                | mirror + state  |
+-----+-----+              +----------------------+                +--------+--------+
      |                                                                     ^
      |  browser (basic auth), ndh watch / status                           |  long-poll
      +------------------------------------------------------->  runners (anywhere, NAT ok)
```

| Machine | Needs | Holds |
|---|---|---|
| Git server | `git`, `ndh`, the hook | bare repos; secrets + variables (server account) |
| Hub machine | `ndh` | run history, logs, artifacts, mirror, registration token |
| Runner machines | `ndh` (or the [Docker image](install.md#4-docker-fleet-runner-image)) | nothing that needs backup |
| Developer laptops | `git` (`ndh` optional, see [below](#teammates-who-install-ndh)) | a clone |

### Set up the pieces, in order

**1. Start the hub** on the hub machine, with team access to the UI:

```bash
ndh hub up --basic-auth ops:PASSWORD
```

```
[ndh] hub up on http://localhost:4949  (ui: yes, basic-auth, auth: on, mirror: on @ http://192.168.1.151:4949/mirror)
[ndh] runner registration token: fa77ae52…
```

The web UI is loopback-only by default; `--basic-auth user:pass` admits
teammates from their own machines
([security model](operations.md#security-model-v01)). Keep the port on a
private network or tailnet. For `--host`, TLS, and running the hub as a
service, see the [operations runbook](operations.md).

**2. Join runners** from each build machine, with the token the hub printed:

```bash
ndh runner join http://hub.internal:4949 --token fa77ae52… --name collab-runner --labels self-hosted
ndh runner start collab-runner
```

**3. Prepare the git server.** Install `ndh` in the account that owns the bare
repos ([install.md](install.md)), then store the team's CI values there:

```bash
ndh secrets backend file             # headless account: use the encrypted file store
ndh secrets set CI_GREETING          # hidden prompt; or pipe the value
ndh vars set DEPLOY_TARGET staging
```

Then point each bare repo at the hub:

```bash
ndh hook install /srv/git/app.git --server http://hub.internal:4949
```

```
[ndh] installed post-receive hook: /srv/git/app.git/hooks/post-receive
[ndh]   server:   http://hub.internal:4949
[ndh]   workflow: (all workflows)
[ndh] push a branch to this repo to trigger CI (needs `ndh` on the server's PATH)
```

The generated hook and its manual equivalent are described in
[operations.md → Trigger CI from a git server](operations.md#trigger-ci-from-a-git-server).
The hook needs `ndh` on the PATH of the account that receives pushes.

**4. Developers clone and push.** No `ndh`, no tokens, no configuration:

```bash
git clone ssh://git@git.internal/srv/git/app.git
```

### What a push looks like

Dev A pushes a workflow that tracks `main` and reads the server-side secret
and variable. The hook dispatches, and the whole run streams back into the
push as `remote:` lines:

```
$ git push origin main
remote: [ndh] injecting 1 secret via ephemeral secret-file
remote: [ndh] injecting 1 var via var-file
remote: Couldn't retrieve github.sha
remote: [.github/workflows/ci.yml] Running: .github/workflows/ci.yml
remote: [app-ci / build] Running: build
remote: [app-ci / build] Succeeded: Set up job
remote: | secret CI_GREETING arrived intact
remote: [app-ci / build] Succeeded: check the injected secret
remote: | deploy target is staging
remote: [app-ci / build] Succeeded: read a variable
remote: [app-ci / build] Job Completed with Status: Succeeded
remote: [.github/workflows/ci.yml] Workflow 1 Completed with Status: Succeeded
remote: All Workflows finished successfully
remote: [ndh] dispatched main (refs/heads/main)
To git.internal:/srv/git/app.git
 * [new branch]      main -> main
```

The transcript is trimmed: every line is from a real push, in order, with
the noisier lines cut. The full stream also carries git's detached-HEAD
advice from the hook's work-tree checkout. It carries the engine's
job-planning lines (`Evaluate job name`, `Queued Job: …`,
`Read Job from Queue: …`) and each step's `##[group]` command block too.

Facts about the push, all verified:

- `Couldn't retrieve github.sha` appears in every hook push, and it is not
  an error ([#139](https://github.com/davidtai/notdownhub/issues/139)).
  The hook dispatches from a temporary work-tree with no git metadata, so
  the engine cannot read the sha there. The run still executes the pushed
  commit, and the results are unaffected.

- The push waits until the dispatched workflows complete. The verified first
  push returned after 33 seconds, action-mirror warm-up included. The hub
  recorded 2 seconds of job time; later pushes recorded about 1 second.
- The engine masks each secret value as `***` in all job output.
- The run executes the pushed commit, checked out by the hook into a
  temporary work-tree on the server.
- CI cannot reject the push with this default `post-receive` hook. The refs
  are already updated when it runs; a failed workflow shows as a red run and
  as failed steps in the push output. To gate pushes on CI, install
  `--type pre-receive` instead; client-side `pre-push` and `post-commit`
  hooks exist too. See
  [operations.md → Hook types](operations.md#hook-types).
- A push while the hub is down still lands. The push output then shows
  `[ndh] can't reach the hub at http://… — is it up?`, and no run is
  recorded. Dispatch the missed commit later from any checkout, or push
  again.

### Branch rules

The hook dispatches every pushed branch with `--ref refs/heads/<branch>`, so
`on: push: branches:` filters behave exactly like a GitHub push. Dev B pushes
a feature branch while the workflow tracks only `main`:

```
$ git push origin feature/logging
remote: | Skipping Workflow, due to branches filter. github.ref='refs/heads/feature/logging'
remote: All Workflows skipped, due to filters
remote: [ndh] dispatched feature/logging (refs/heads/feature/logging)
```

The push returns at once, and the hub records the run as `completed/skipped`.
Dev B's later push to `main` ran to completion — the filter, not the
developer, decides. Details:
[operations.md → Branch tracking](operations.md#branch-tracking).

### Where secrets live, and why

`ndh` resolves secrets and variables on the dispatching machine, at dispatch
time. With a git-server hook, the dispatching machine is the git server. The
server administrator stores the team's values once, in the server account.
This was verified end to end: `${{ secrets.CI_GREETING }}` set on the server
arrived intact in a hook-triggered job. The laptop that pushed had no secret
store at all.

Two notes:

- Repo-scoped values (`--repo owner/name`) attach to hook runs whose project
  slug matches ([#99](https://github.com/davidtai/notdownhub/issues/99)).
  The slug is shown by `ndh hook install`; see
  [Project labels on a git server](#project-labels-on-a-git-server).
  Global values attach to every run.
- On a headless server account, run `ndh secrets backend file` before the
  first `ndh secrets set` ([why](install.md#ndh_home-layout)).

### How the team sees results

**The web UI**, from any teammate's browser, with the `--basic-auth`
credentials. Verified against a non-loopback address:

```
$ curl -s -o /dev/null -w '%{http_code}' http://hub.internal:4949/
401
$ curl -s -o /dev/null -w '%{http_code}' -u ops:PASSWORD http://hub.internal:4949/
200
```

Wrong credentials get `401` again. With credentials, the UI also serves the
persisted job logs of finished runs (verified: `/api/local/joblogs/…` answers
`401` without credentials and `200` with them).

**The CLI**, from any machine that can reach port 4949 — these commands read
the open API and need no credentials:

```bash
ndh status   --server http://hub.internal:4949   # runners + recent runs
ndh projects --server http://hub.internal:4949   # per-project rollup
ndh watch 5  --server http://hub.internal:4949   # follow a live run's console
```

`ndh watch` followed a live hook-triggered run from a second machine and
exited when the run completed. On a machine other than the hub, `ndh status`
lists runner names without labels or live state; the rich view needs the
hub's own database. `ndh logs <run-id>` reads a loopback-gated endpoint: run
it on the hub machine, or through an SSH tunnel. On a `--basic-auth` hub, a
remote `ndh logs` reports the auth gate and exits with an error
([#100](https://github.com/davidtai/notdownhub/issues/100)).

### Project labels on a git server

`ndh hook install` bakes a project label into the generated hook
([#99](https://github.com/davidtai/notdownhub/issues/99)). Every push of a
repo lands under one stable project in the UI and in `ndh projects`. The
default label comes from the bare repo path: `/srv/git/team/app.git` becomes
`team/app`. In a flat layout the containing directory names the owner:
`/srv/git/app.git` becomes `git/app`. Pass
`ndh hook install --repository owner/name` to override the derived label.

### Add a project before its first run

A project normally appears only after its first run. You can register one
earlier, from its workflow YAML. Use the **Add project** wizard on the
Projects page, or the CLI:

```bash
ndh project add -W .github/workflows/ci.yml --server http://hub.internal:4949
```

Both surfaces parse the file: name, events, branches, and `runs-on` labels.
Labels are checked against the live fleet, with a warning when none match.
The project then shows as **planned**, with the exact dispatch command.
The first run with the same slug absorbs the placeholder. Without
`--repository`, the slug comes from the checkout's origin remote.

### Rename a job's display name

You can give a job a friendlier display name. This is an alias, never an
override: the workflow YAML and the engine's records stay untouched. Use the
pencil on a job row (run detail or Projects breakdown), or the CLI:

```bash
ndh project alias owner/repo build "Compile & Ship"
ndh project alias owner/repo build --clear
```

The alias shows everywhere the UI names the job. The original name stays
on hover, and `ndh logs` prints `alias (original)`. Clearing the alias
restores the original name everywhere.

The same label scopes secrets and variables. A server-side value stored with
`--repo owner/name` injects into that repo's hook runs. Re-run `ndh hook
install` on a repo with an older generated hook to pick this up.

### More than one project on one server

One hook per bare repo; each repo gets its own `ndh hook install`. Verified
with two bare repos dispatching to the same hub:

```bash
ndh hook install /srv/git/lib.git --server http://hub.internal:4949 -W .github/workflows/ci.yml
```

`-W` restricts a repo's hook to one workflow file. Runs from both repos
appear in the same hub UI, runs list, and `ndh projects` rollup.

### Teammates who install ndh

A teammate with `ndh` installed can also dispatch a working tree straight to
the shared hub — CI before the branch leaves the laptop:

```bash
ndh dispatch --server http://hub.internal:4949 --event push --ref refs/heads/main
```

The dispatching machine is now the laptop, so secrets resolve from the
laptop's own store. Verified: a laptop without `CI_GREETING` failed the
secret-check step; after `ndh secrets set CI_GREETING` on the laptop, the
same dispatch succeeded. The whole model in one line: a push uses the
server's secrets, and a direct dispatch uses yours.
