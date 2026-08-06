# notdownhub demo repo

A minimal sample repo whose single workflow
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) exercises the parts of
GitHub Actions that a faithful engine has to get right:

- a build **matrix** (`flavor: [alpha, beta, gamma]`)
- **`actions/checkout@v4`** (a real marketplace action, fetched once through
  the hub's mirror then served from cache)
- **job outputs** via `$GITHUB_OUTPUT`
- a **`needs:` graph** (`report` waits for every leg of `build`)

The exact same file runs on github.com, locally with `ndh run`, and on a fleet
with `ndh dispatch`.

## Prerequisites

```bash
# one-time: download the pinned runner stack (~66 MB)
ndh install
# (or `pnpm dlx notdownhub install` / `npx notdownhub install` if ndh isn't on PATH)
```

If you don't have Docker, `ubuntu-latest` jobs run on your host machine; that's
fine for this demo. With Docker present they run in `catthehacker/ubuntu:act-latest`.

## Run it locally (one-shot)

From this directory:

```bash
ndh run
```

`ndh run` starts an in-process hub + runner, executes the workflow, streams the
logs, and exits. Useful variations:

```bash
ndh run -l                              # list the jobs for the default (push) event
ndh run -W .github/workflows/ci.yml     # point at this workflow explicitly
ndh run --event pull_request            # run as if triggered by a PR
ndh run -j build -m flavor:beta         # just one job, just one matrix leg
```

Expected: three `build` legs (alpha/beta/gamma) run, then `report` prints
`build says: 'hello-from-…'`, proving the `needs:` edge and output plumbing.

## Run it on a fleet (dispatch)

With a hub already up (`ndh hub up` on the hub machine) and at least one runner
joined and started, dispatch this repo's workflow to the fleet:

```bash
ndh dispatch --server http://hub.tailnet:4949 --event push
ndh status  --server http://hub.tailnet:4949      # watch runners + recent runs
```

`dispatch` forwards the same `Runner.Client` flags as `run` (`-W`, `--event`,
`-j`, `-m`, …), so everything you tried locally works against the fleet too.
