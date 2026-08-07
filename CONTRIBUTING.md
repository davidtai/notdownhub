# Contributing to notdownhub

Thank you for helping improve notdownhub. This guide covers the development
setup, the repo layout, the demo, and the conventions for commits and pull
requests.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. Report security
issues through [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Requirements: Node.js >= 22.13 and pnpm 11.8.0 (through corepack).

Clone the repo and install dependencies:

```bash
git clone https://github.com/davidtai/notdownhub
cd notdownhub
pnpm install
```

Build every package:

```bash
pnpm -r build
```

Run the tests:

```bash
pnpm -r test
```

## Quality gates

The CLI test run enforces a coverage gate through c8. The gate is 95% lines and
90% branches. This gate must stay green, so add tests with any code change.

Every Markdown doc must pass the Simplified Technical English (STE) checker. Run
the checker with `pnpm docs:style`. CI runs the same build, test, and style
checks on every push and pull request.

## Monorepo layout

The repo is a pnpm workspace with two packages:

- `packages/cli` — the `ndh` CLI, published to npm as `notdownhub`.
- `apps/web` — the hub web UI.

The `ndh` command is the product. The web UI is served by the hub on its single
public port.

## Run the demo

A ready-to-run sample repo lives in [`examples/demo`](examples/demo). It has a
matrix build, job outputs, and a `needs:` graph.

Run its workflow locally from a clone:

```bash
cd examples/demo
ndh run
```

See [`examples/demo/README.md`](examples/demo/README.md) for the matrix, the job
outputs, and the dispatch variations.

## Commit and pull request conventions

- Write commit subjects in the imperative mood.
- Keep the subject line short and specific.
- Reference the issue a pull request addresses.
- Confirm the build and tests pass before you open a pull request.
- Run the docs style check when you change any Markdown.
- Update the docs when you change behavior.

See [`docs/files.md`](docs/files.md) for the locations of every generated file.
