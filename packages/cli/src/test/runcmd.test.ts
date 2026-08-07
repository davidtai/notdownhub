import { test } from "node:test";
import assert from "node:assert/strict";
import { runCmd, dispatchCmd, __test } from "../runcmd.js";

const { defaultPlatformArgs, projectSlug, repositoryArgs, serverArg } = __test;

/** Capture the exact Runner.Client argv without spawning, and stub vendor/slug/probe. */
function capture(repoSlug: () => string | null) {
  let captured: string[] | null = null;
  return {
    deps: {
      runner: async (_cmd: string, args: string[]) => {
        captured = args;
        return 0;
      },
      ensure: async () => undefined,
      repoSlug,
      // Dispatch pre-flights the hub; in unit tests the hub is always "reachable" so the
      // real Runner.Client argv is exercised. The unreachable path is tested separately.
      probe: async () => ({ ok: true }),
    },
    argv: () => captured,
    spawned: () => captured !== null,
  };
}

test("defaultPlatformArgs: user-supplied -P / --platform suppresses the defaults", () => {
  assert.deepEqual(defaultPlatformArgs(["-P", "x=y"]), []);
  assert.deepEqual(defaultPlatformArgs(["--platform", "x=y"]), []);
});

test("defaultPlatformArgs: linux images map to docker when available", () => {
  const args = defaultPlatformArgs(["--event", "push"], () => true);
  assert.ok(args.includes("ubuntu-latest=catthehacker/ubuntu:act-latest"));
  assert.ok(args.includes("ubuntu-24.04=catthehacker/ubuntu:act-latest"));
  assert.ok(args.includes("self-hosted=-self-hosted"));
});

test("defaultPlatformArgs: linux images fall back to the host without docker", () => {
  const args = defaultPlatformArgs(["--event", "push"], () => false);
  assert.ok(args.includes("ubuntu-latest=-self-hosted"));
  assert.ok(args.includes("macos-latest=-self-hosted"));
  assert.ok(args.includes("windows-latest=-self-hosted"));
});

test("projectSlug: uses the origin slug when present", () => {
  assert.equal(projectSlug("acme/widget", "/anything"), "acme/widget");
});

test("projectSlug: falls back to local/<dirname> (a two-part slug, never Unknown)", () => {
  // A two-part slug is required: the engine records `--repository` verbatim and
  // splits on "/" for the owner, so a bare value would render as Unknown/Unknown.
  assert.equal(projectSlug(null, "/home/dev/my-project"), "local/my-project");
});

test("projectSlug: sanitizes odd directory names and never yields an empty repo", () => {
  assert.equal(projectSlug(null, "/tmp/My Repo!"), "local/My-Repo");
  assert.equal(projectSlug(null, "/"), "local/workspace");
});

test("repositoryArgs: injects --repository when the user did not", () => {
  assert.deepEqual(repositoryArgs(["--event", "push"], "acme/widget"), ["--repository", "acme/widget"]);
});

test("repositoryArgs: yields nothing when the user already passed --repository", () => {
  assert.deepEqual(repositoryArgs(["--repository", "me/mine"], "acme/widget"), []);
  assert.deepEqual(repositoryArgs(["--repository=me/mine"], "acme/widget"), []);
});

test("runCmd: prepends --repository <origin slug> ahead of the user argv", async () => {
  const cap = capture(() => "acme/widget");
  const code = await runCmd(["-W", ".github/workflows"], cap.deps);
  assert.equal(code, 0);
  const args = cap.argv()!;
  const i = args.indexOf("--repository");
  assert.ok(i >= 0 && args[i + 1] === "acme/widget");
  // It comes before the user's own arguments so a later user value would win.
  assert.ok(i < args.indexOf("-W"));
});

test("runCmd: does not duplicate --repository when the user supplies one", async () => {
  const cap = capture(() => "acme/widget");
  await runCmd(["--repository", "me/mine", "-W", "."], cap.deps);
  const args = cap.argv()!;
  assert.equal(args.filter((a) => a === "--repository").length, 1);
  assert.ok(!args.includes("acme/widget"));
});

test("runCmd: falls back to a local/ slug when there is no origin remote", async () => {
  const cap = capture(() => null);
  await runCmd(["-W", "."], cap.deps);
  const args = cap.argv()!;
  const i = args.indexOf("--repository");
  assert.ok(i >= 0);
  assert.match(args[i + 1], /^local\/.+/);
});

test("dispatchCmd: requires --server and injects --repository", async () => {
  const cap = capture(() => "acme/widget");
  assert.equal(await dispatchCmd(["-W", "."], cap.deps), 2); // missing --server

  const ok = capture(() => "acme/widget");
  assert.equal(await dispatchCmd(["--server", "http://hub:4949", "-W", "."], ok.deps), 0);
  const args = ok.argv()!;
  const i = args.indexOf("--repository");
  assert.ok(i >= 0 && args[i + 1] === "acme/widget");
});

test("serverArg: reads --server <url> and --server=<url>, else null", () => {
  assert.equal(serverArg(["--server", "http://hub:4949", "-W", "."]), "http://hub:4949");
  assert.equal(serverArg(["--server=http://hub:4949"]), "http://hub:4949");
  assert.equal(serverArg(["-W", "."]), null);
  assert.equal(serverArg(["--server"]), null); // dangling flag, no value
});

test("dispatchCmd: an unreachable hub prints one [ndh] line + the underlying error, exits 1, never spawns", async () => {
  const cap = capture(() => "acme/widget");
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const code = await dispatchCmd(["--server", "http://127.0.0.1:6099", "-W", "."], {
      ...cap.deps,
      probe: async () => ({ ok: false, code: "ECONNREFUSED", detail: "connect ECONNREFUSED 127.0.0.1:6099" }),
    });
    assert.equal(code, 1);
    assert.equal(cap.spawned(), false, "Runner.Client must not be spawned when the hub is unreachable");
    const out = logs.join("\n");
    assert.match(out, /can't reach the hub at http:\/\/127\.0\.0\.1:6099/);
    assert.match(out, /ndh hub up/);
    assert.match(out, /connect ECONNREFUSED 127\.0\.0\.1:6099/); // underlying error on its own line
    assert.doesNotMatch(out, /Exception:/); // the leaked vendored error is gone
  } finally {
    console.error = orig;
  }
});

test("dispatchCmd: a reachable hub proceeds to spawn Runner.Client (probe ok)", async () => {
  const cap = capture(() => "acme/widget");
  const code = await dispatchCmd(["--server", "http://hub:4949", "--event", "push"], {
    ...cap.deps,
    probe: async () => ({ ok: true }),
  });
  assert.equal(code, 0);
  assert.ok(cap.spawned(), "reachable hub -> Runner.Client is invoked");
});
