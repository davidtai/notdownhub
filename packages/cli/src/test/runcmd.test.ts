import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd, dispatchCmd, __test } from "../runcmd.js";
import { setSecret } from "../secrets.js";

const { defaultPlatformArgs, projectSlug, repositoryArg, repositoryArgs, serverArg } = __test;

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

test("repositoryArg: reads --repository <slug> and --repository=<slug>, else null", () => {
  assert.equal(repositoryArg(["--repository", "team/app", "-W", "."]), "team/app");
  assert.equal(repositoryArg(["--repository=team/app"]), "team/app");
  assert.equal(repositoryArg(["-W", "."]), null);
  assert.equal(repositoryArg(["--repository"]), null); // dangling flag, no value
});

test("dispatchCmd: an explicit --repository scopes repo secrets even with no origin remote (#99)", async () => {
  // The git-server hook dispatches from a temp work-tree: repoSlug is null there.
  // A secret stored under the explicit slug must still reach the run via --secret-file.
  const savedHome = process.env.NDH_HOME;
  const savedBackend = process.env.NDH_SECRETS_BACKEND;
  process.env.NDH_HOME = mkdtempSync(join(tmpdir(), "ndh-hook-scope-"));
  process.env.NDH_SECRETS_BACKEND = "file";
  try {
    await setSecret("team/app", "HOOK_TOKEN", "sekret");

    // Without --repository (pre-#99 hook shape): the repo-scoped secret must NOT attach.
    const bare = capture(() => null);
    await dispatchCmd(["--server", "http://hub:4949", "--event", "push"], bare.deps);
    assert.ok(!bare.argv()!.includes("--secret-file"), "no slug -> repo-scoped secret must not inject");

    // With --repository team/app baked in by the generated hook: it must attach.
    const cap = capture(() => null);
    await dispatchCmd(["--server", "http://hub:4949", "--repository", "team/app", "--event", "push"], cap.deps);
    assert.ok(cap.argv()!.includes("--secret-file"), "explicit --repository must scope the secret in");
  } finally {
    process.env.NDH_HOME = savedHome;
    if (savedBackend === undefined) delete process.env.NDH_SECRETS_BACKEND;
    else process.env.NDH_SECRETS_BACKEND = savedBackend;
  }
});

test("serverArg: reads --server <url> and --server=<url>, else null", () => {
  assert.equal(serverArg(["--server", "http://hub:4949", "-W", "."]), "http://hub:4949");
  assert.equal(serverArg(["--server=http://hub:4949"]), "http://hub:4949");
  assert.equal(serverArg(["-W", "."]), null);
  assert.equal(serverArg(["--server"]), null); // dangling flag, no value
});

/** Run dispatchCmd with console.error captured; returns exit code + joined stderr. */
async function dispatchWithLogs(argv: string[], deps: Parameters<typeof dispatchCmd>[1]) {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const code = await dispatchCmd(argv, deps);
    return { code, out: logs.join("\n") };
  } finally {
    console.error = orig;
  }
}

test("dispatchCmd: a DEFINITIVE-down hub prints one [ndh] line + the underlying error, exits 1, never spawns", async () => {
  const cap = capture(() => "acme/widget");
  const { code, out } = await dispatchWithLogs(["--server", "http://127.0.0.1:6099", "-W", "."], {
    ...cap.deps,
    probe: async () => ({ ok: false, code: "ECONNREFUSED", detail: "connect ECONNREFUSED 127.0.0.1:6099" }),
  });
  assert.equal(code, 1);
  assert.equal(cap.spawned(), false, "Runner.Client must not be spawned when the hub is definitively down");
  assert.match(out, /can't reach the hub at http:\/\/127\.0\.0\.1:6099/);
  assert.match(out, /ndh hub up/);
  assert.match(out, /connect ECONNREFUSED 127\.0\.0\.1:6099/); // underlying error on its own line
  assert.doesNotMatch(out, /Exception:/); // the leaked vendored error is gone
});

test("dispatchCmd: every DEFINITIVE-down code hard-blocks (refused/dns/route)", async () => {
  for (const c of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]) {
    const cap = capture(() => "acme/widget");
    const { code } = await dispatchWithLogs(["--server", "http://hub:4949", "-W", "."], {
      ...cap.deps,
      probe: async () => ({ ok: false, code: c, detail: `${c} detail` }),
    });
    assert.equal(code, 1, `${c} must hard-block`);
    assert.equal(cap.spawned(), false, `${c} must not spawn`);
  }
});

test("dispatchCmd: an AMBIGUOUS probe (reset) warns but PROCEEDS to spawn Runner.Client (#85)", async () => {
  const cap = capture(() => "acme/widget");
  const { code, out } = await dispatchWithLogs(["--server", "http://hub:4949", "--event", "push"], {
    ...cap.deps,
    probe: async () => ({ ok: false, code: "ECONNRESET", detail: "read ECONNRESET" }),
  });
  assert.equal(code, 0);
  assert.ok(cap.spawned(), "a reset probe must not block a hub that may be up");
  assert.match(out, /slow\/reset to reach; continuing/);
  assert.doesNotMatch(out, /can't reach the hub/); // NOT the hard-block message
});

test("dispatchCmd: an AMBIGUOUS probe (timeout) warns but PROCEEDS to spawn Runner.Client (#85)", async () => {
  const cap = capture(() => "acme/widget");
  const { code, out } = await dispatchWithLogs(["--server", "http://hub:4949", "--event", "push"], {
    ...cap.deps,
    probe: async () => ({ ok: false, code: "ETIMEDOUT", detail: "timed out" }),
  });
  assert.equal(code, 0);
  assert.ok(cap.spawned(), "a timeout probe must not block a hub that may be up");
  assert.match(out, /slow\/reset to reach; continuing/);
});

test("dispatchCmd: a reachable hub proceeds to spawn Runner.Client, silently (probe ok)", async () => {
  const cap = capture(() => "acme/widget");
  const { code, out } = await dispatchWithLogs(["--server", "http://hub:4949", "--event", "push"], {
    ...cap.deps,
    probe: async () => ({ ok: true }),
  });
  assert.equal(code, 0);
  assert.ok(cap.spawned(), "reachable hub -> Runner.Client is invoked");
  assert.equal(out, "", "a reachable hub logs nothing at the pre-flight");
});
