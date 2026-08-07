# notdownhub CLI (`ndh`)

The `ndh` command: run unmodified GitHub Actions CI on your own infrastructure. See the
[repo README](../../README.md) for the product overview and usage.

## Development

```sh
pnpm --filter notdownhub build   # tsc -> dist/
pnpm --filter notdownhub test    # coverage-gated tests (below)
```

## Test coverage

Tests are `node:test` suites in `src/test/`, compiled to `dist/test/` and run there. The `test`
script wraps the runner in [`c8`](https://github.com/bcoe/c8) with `--check-coverage`, so **CI fails
the build if coverage regresses** (`pnpm -r test` runs this script, so no CI-specific wiring is
needed). Thresholds (`.c8rc.json`):

| metric | gate |
| ------ | ---- |
| lines | 95% |
| branches | 90% |
| functions | 90% |
| statements | 95% |

### How it's measured

- Coverage is collected on the compiled `dist/*.js` and **remapped to `src/*.ts`** via source maps
  (`tsconfig.json` has `"sourceMap": true`), so reported numbers and line references point at the
  TypeScript sources. `.c8rc.json` `include`/`exclude` filter on the pre-remap `dist` path
  (`dist/test/**` is excluded — the tests don't count toward coverage).
- `c8` sets `NODE_V8_COVERAGE`, which child processes inherit. Tests that exercise the CLI end to end
  spawn the built `dist/index.js` as a real subprocess (see `src/test/helpers.ts` `runCli`), and that
  subprocess coverage is merged in automatically — this is how `index.ts`'s `main()` is covered.
- Network-facing code is tested against **real local HTTP servers on ephemeral ports** (fake hub /
  upstream / vendor-download fixtures), never mocked modules. Spawn boundaries use dependency-
  injection seams (`RunDeps` in `runcmd.ts`, `HubDeps` in `hub.ts`, `RunnerDeps` in `runner.ts`) so
  orchestration logic is testable without the ~200 MB vendored runner bundle.
- `NDH_MIRROR_UPSTREAM` overrides the action-mirror upstream (default `https://api.github.com`) so the
  mirror can be pointed at a fixture (or a GitHub Enterprise host) — added as part of the coverage work.

### `c8 ignore` exclusions (kept rare and justified)

- `secrets.ts` `promptHidden()` — the interactive hidden-input path needs a real raw-mode TTY the test
  harness can't drive. The non-TTY paths (`--value`, piped stdin) in `readSecretValue` are covered.
- `index.ts` — the fallback `run`/`dispatch` command action bodies. `main()` intercepts those verbs
  before commander parses them, so the actions never execute; the registrations exist only so the verbs
  appear in `ndh --help`.
