import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  INNER_ACTION_YML,
  INNER_INDEX_JS,
  buildInnerArchive,
  innerArchiveFormat,
  serveInnerLocalcheckout,
  __test as innerTest,
} from "../localcheckout-inner.js";
import { startFront } from "../front.js";

afterEach(() => {
  innerTest.resetArchiveCache();
  delete process.env.NDH_INNER_LOCALCHECKOUT;
});

// ---- action.yml surface ---------------------------------------------------------------------

test("inner action: declares the full checkout@v4 surface plus checkoutref (superset of both outers)", () => {
  // The ndh outer composite (#106) passes 13 inputs; the ENGINE's own outer additionally passes
  // fetch-tags (the #98 bug). Declaring the full surface keeps every outer/inner combination
  // warning-free, including the mixed fallback states.
  const surface = [
    "repository",
    "ref",
    "token",
    "ssh-key",
    "ssh-known-hosts",
    "ssh-strict",
    "ssh-user",
    "persist-credentials",
    "path",
    "clean",
    "filter",
    "sparse-checkout",
    "sparse-checkout-cone-mode",
    "fetch-depth",
    "fetch-tags",
    "show-progress",
    "lfs",
    "submodules",
    "set-safe-directory",
    "github-server-url",
    "checkoutref",
  ];
  const inputsBlock = INNER_ACTION_YML.slice(INNER_ACTION_YML.indexOf("inputs:"), INNER_ACTION_YML.indexOf("outputs:"));
  for (const name of surface) {
    assert.ok(new RegExp(`^  ${name}:`, "m").test(inputsBlock), `input '${name}' must be declared`);
  }
});

test("inner action: node20 runtime, index.js entry, declares the skip output", () => {
  assert.ok(INNER_ACTION_YML.includes("using: 'node20'"), "vendored runner defaults to node20; node16 is EOL");
  assert.ok(INNER_ACTION_YML.includes("main: 'index.js'"));
  assert.ok(/^outputs:\n  skip:/m.test(INNER_ACTION_YML), "the composite branches on steps.local.outputs.skip");
});

// ---- the deprecated command must be gone ----------------------------------------------------

test("inner action: no set-output string anywhere — source, manifest, or served archives", () => {
  assert.ok(!INNER_INDEX_JS.includes("set-output"));
  assert.ok(!INNER_ACTION_YML.includes("set-output"));
  assert.ok(INNER_INDEX_JS.includes("GITHUB_OUTPUT"), "outputs go through the env file");
  for (const format of ["tarball", "zipball"] as const) {
    const archive = buildInnerArchive(format);
    const raw = format === "tarball" ? gunzipSync(archive) : archive; // zip entries are stored
    assert.ok(!raw.includes(Buffer.from("set-output")), `${format} must not carry set-output`);
  }
});

test("inner action: index.js parses standalone (node --check, no dependencies)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ndh-inner-"));
  const file = join(dir, "index.js");
  writeFileSync(file, INNER_INDEX_JS);
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!INNER_INDEX_JS.includes("@actions/"), "no @actions/* usage may survive the port");
});

// ---- archives -------------------------------------------------------------------------------

test("inner action: tarball carries action.yml + index.js under one strippable root", () => {
  const raw = gunzipSync(buildInnerArchive("tarball"));
  assert.ok(raw.includes(Buffer.from("archive/action.yml")));
  assert.ok(raw.includes(Buffer.from("archive/index.js")));
  assert.equal(raw.length % 512, 0, "tar stream is block-aligned");
  assert.equal(buildInnerArchive("tarball"), buildInnerArchive("tarball"), "built once, then cached");
});

test("inner action: zipball is a valid stored archive with both entries", () => {
  const zip = buildInnerArchive("zipball");
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "local file header signature");
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, "end-of-central-directory signature");
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 3, "root dir + action.yml + index.js");
  assert.ok(zip.includes(Buffer.from("archive/index.js")));
});

test("inner action: innerArchiveFormat matches only the two static archive paths", () => {
  assert.equal(innerArchiveFormat("/localcheckout.tar.gz"), "tarball");
  assert.equal(innerArchiveFormat("/localcheckout.zip"), "zipball");
  assert.equal(innerArchiveFormat("/tenant/localcheckout.tar.gz"), "tarball");
  assert.equal(innerArchiveFormat("/localcheckoutazure.zip"), null, "the azure task stays untouched");
  assert.equal(innerArchiveFormat("/localcheckout"), null, "#34's generic path is not an archive");
  assert.equal(innerArchiveFormat("/ui/localcheckout.tar.gz.html"), null);
});

// ---- live behavior of the generated index.js ------------------------------------------------

/**
 * Body bytes exactly as Runner.Client's MultipartFormDataContent produces them. .NET quotes a
 * disposition parameter only when the value is not an HTTP token — "644:x" and "a/b" get quotes,
 * a root-level "README.txt" does not — and file parts also carry an RFC 5987 filename*.
 */
function dotnetParam(key: string, value: string): string {
  const quoted = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value) ? value : `"${value}"`;
  return `${key}=${quoted}`;
}

function dotnetMultipart(
  boundary: string,
  parts: { name: string; filename?: string; data: Buffer }[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const filename =
      p.filename !== undefined
        ? `; ${dotnetParam("filename", p.filename)}; filename*=utf-8''${encodeURIComponent(p.filename)}`
        : "";
    chunks.push(Buffer.from(`Content-Disposition: form-data; ${dotnetParam("name", p.name)}${filename}\r\n\r\n`));
    chunks.push(p.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

interface InnerRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ws: string;
  outputFile: string;
}

/** Extract index.js to a temp dir and run it against a hub stub, like the runner would. */
function runInner(
  hub: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  inputs: Record<string, string>,
  prepare?: (ws: string) => void,
): Promise<InnerRun> {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "ndh-inner-run-"));
    const ws = join(dir, "workspace");
    mkdirSync(ws);
    prepare?.(ws);
    const actionFile = join(dir, "index.js");
    writeFileSync(actionFile, INNER_INDEX_JS);
    const outputFile = join(dir, "github_output");
    writeFileSync(outputFile, "pre-existing=kept\n");
    const server = http.createServer(hub);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const env: Record<string, string> = {
        ...process.env,
        GITHUB_WORKSPACE: ws,
        GITHUB_OUTPUT: outputFile,
        GITHUB_RUN_ID: "77",
        GITHUB_REPOSITORY: "local/repo",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: "0000000000000000000000000000000000000000",
        ACTIONS_RUNTIME_URL: `http://127.0.0.1:${port}/`,
      };
      for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.replace(/ /g, "_").toUpperCase()}`] = v;
      const child = spawn(process.execPath, [actionFile], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => {
        server.close(() => resolve({ code, stdout, stderr, ws, outputFile }));
      });
    });
  });
}

const BOUNDARY = "e3f0e0f6-1c9c-4a2b-9d1a-0123456789ab";

test("inner action e2e: streams the tree, writes skip=true to GITHUB_OUTPUT, zero warnings", async () => {
  // Binary payload containing CRLFs and a boundary-lookalike, to stress the parser.
  const binary = Buffer.concat([Buffer.from("\r\n--" + BOUNDARY.slice(0, 8)), Buffer.from([0, 1, 2, 255]), Buffer.from("\r\n")]);
  const unicodeName = Buffer.from("644:üni.txt", "utf8").toString("base64");
  const body = dotnetMultipart(BOUNDARY, [
    { name: "644:README.md", filename: "README.md", data: Buffer.from("hello") },
    { name: "755:tools/run.sh", filename: "tools/run.sh", data: Buffer.from("#!/bin/sh\necho hi\n") },
    { name: "644:.git/HEAD", filename: ".git/HEAD", data: Buffer.from("ref: refs/heads/main\n") },
    { name: "644:bin/blob", filename: "bin/blob", data: binary },
    { name: `=?utf-8?B?${unicodeName}?=`, filename: "uni.txt", data: Buffer.from("u") },
    { name: "lnk:link.txt", data: Buffer.from("README.md") },
  ]);
  let requestedUrl = "";
  const run = await runInner(
    (req, res) => {
      requestedUrl = req.url ?? "";
      res.writeHead(200, { "content-type": `multipart/form-data; boundary="${BOUNDARY}"` });
      // Drip-feed in small chunks so every marker straddles a chunk edge at least once.
      let i = 0;
      const step = () => {
        if (i >= body.length) return res.end();
        res.write(body.subarray(i, i + 7));
        i += 7;
        setImmediate(step);
      };
      step();
    },
    // The outer composite always passes repository (default github.repository), like here.
    { checkoutref: "v2", clean: "true", repository: "local/repo" },
    (ws) => writeFileSync(join(ws, "stale.txt"), "must be cleaned"),
  );

  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(requestedUrl, "/_apis/v1/Message/multipart/77?submodules=false&nestedSubmodules=false");
  // The tree, including .git and exact binary bytes, landed in the workspace.
  assert.equal(readFileSync(join(run.ws, "README.md"), "utf8"), "hello");
  assert.equal(readFileSync(join(run.ws, ".git/HEAD"), "utf8"), "ref: refs/heads/main\n");
  assert.deepEqual(readFileSync(join(run.ws, "bin/blob")), binary);
  assert.equal(readFileSync(join(run.ws, "üni.txt"), "utf8"), "u", "RFC 2047 names decode");
  assert.equal(readlinkSync(join(run.ws, "link.txt")), "README.md", "symlinks are restored");
  if (process.platform !== "win32") {
    assert.ok(statSync(join(run.ws, "tools/run.sh")).mode & 0o100, "755 parts keep the exec bit");
  }
  assert.ok(!existsSync(join(run.ws, "stale.txt")), "clean: true empties the destination first");
  // Modern output handling: env-file append, nothing clobbered, no deprecated command.
  const out = readFileSync(run.outputFile, "utf8");
  assert.ok(out.startsWith("pre-existing=kept\n"), "GITHUB_OUTPUT is appended to, never rewritten");
  assert.match(out, /skip<<ghadelimiter_[0-9a-f-]+\ntrue\nghadelimiter_/);
  assert.ok(!run.stdout.includes("::set-output"), "the deprecated command must never appear");
  assert.ok(!run.stdout.includes("::warning"), "a clean run emits zero warning annotations");
  assert.ok(!run.stdout.includes("::error"));
});

test("inner action e2e: non-200 hub answer writes skip=false and defers to the remote fallback", async () => {
  let requestedUrl = "";
  const run = await runInner(
    (req, res) => {
      requestedUrl = req.url ?? "";
      res.writeHead(404);
      res.end();
    },
    { checkoutref: "v2", repository: "other/repo", ref: "dev" },
  );
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.ok(requestedUrl.includes("&repositoryAndRef=other%2Frepo%40dev"), "foreign repo@ref rides the query");
  assert.match(readFileSync(run.outputFile, "utf8"), /skip<<ghadelimiter_[0-9a-f-]+\nfalse\n/);
  assert.ok(!run.stdout.includes("::set-output"));
  assert.ok(!run.stdout.includes("::error"));
});

test("inner action e2e: clean=false keeps existing workspace files", async () => {
  const body = dotnetMultipart(BOUNDARY, [{ name: "644:new.txt", filename: "new.txt", data: Buffer.from("n") }]);
  const run = await runInner(
    (_req, res) => {
      res.writeHead(200, { "content-type": `multipart/form-data; boundary=${BOUNDARY}` });
      res.end(body);
    },
    { checkoutref: "v2", clean: "false" },
    (ws) => writeFileSync(join(ws, "keep.txt"), "kept"),
  );
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(readFileSync(join(run.ws, "keep.txt"), "utf8"), "kept");
  assert.equal(readFileSync(join(run.ws, "new.txt"), "utf8"), "n");
});

test("inner action e2e: entries escaping the destination are refused with a warning", async () => {
  const body = dotnetMultipart(BOUNDARY, [
    { name: "644:../escape.txt", filename: "../escape.txt", data: Buffer.from("nope") },
    { name: "644:ok.txt", filename: "ok.txt", data: Buffer.from("ok") },
  ]);
  const run = await runInner((_req, res) => {
    res.writeHead(200, { "content-type": `multipart/form-data; boundary=${BOUNDARY}` });
    res.end(body);
  }, { checkoutref: "v2" });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(readFileSync(join(run.ws, "ok.txt"), "utf8"), "ok");
  assert.ok(!existsSync(join(run.ws, "..", "escape.txt")), "no write outside the workspace");
  assert.ok(run.stdout.includes("::warning::Refusing entry outside the destination"));
});

test("inner action e2e: a truncated stream fails the step instead of passing half a tree", async () => {
  const body = dotnetMultipart(BOUNDARY, [{ name: "644:part.txt", filename: "part.txt", data: Buffer.from("partial") }]);
  const run = await runInner((_req, res) => {
    res.writeHead(200, { "content-type": `multipart/form-data; boundary=${BOUNDARY}` });
    res.write(body.subarray(0, body.length - 12)); // cut inside the closing boundary
    res.end();
  }, { checkoutref: "v2" });
  assert.equal(run.code, 1);
  assert.ok(run.stdout.includes("::error::Repository stream ended before the closing multipart boundary"));
});

test("inner action e2e: v1 checkoutref maps the destination like the engine action did", async () => {
  const body = dotnetMultipart(BOUNDARY, [{ name: "644:f.txt", filename: "f.txt", data: Buffer.from("v1") }]);
  const run = await runInner((_req, res) => {
    res.writeHead(200, { "content-type": `multipart/form-data; boundary=${BOUNDARY}` });
    res.end(body);
  }, { checkoutref: "v1", clean: "false" });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  // v1 semantics (ported verbatim): dest = <parent of workspace>/<basename of that parent>. On
  // the v1 runner layout (_work/repo/repo) that reconstructs the workspace path itself.
  const parent = join(run.ws, "..");
  assert.equal(readFileSync(join(parent, basename(parent), "f.txt"), "utf8"), "v1");
});

// ---- serving through the front --------------------------------------------------------------

function fakeHub() {
  const server = http.createServer((_rq, rs) => {
    rs.writeHead(200, { "content-type": "application/octet-stream" });
    rs.end("engine-inner-bytes");
  });
  return server;
}

function get(port: number, path: string): Promise<{ status: number; body: Buffer; type?: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), type: res.headers["content-type"] }),
        );
      })
      .on("error", reject);
  });
}

test("front: GET /localcheckout.tar.gz|.zip serves the ndh inner action; azure zip stays proxied", async () => {
  const hub = fakeHub();
  await new Promise<void>((r) => hub.listen(0, r));
  const hubPort = (hub.address() as { port: number }).port;
  const front = startFront({ port: 0, hubPort, uiDir: null });
  const frontPort = (front.address() as { port: number }).port;

  const tar = await get(frontPort, "/localcheckout.tar.gz");
  assert.equal(tar.status, 200);
  assert.equal(tar.type, "application/octet-stream");
  assert.ok(gunzipSync(tar.body).includes(Buffer.from("notdownhub inner localcheckout")));

  const zip = await get(frontPort, "/localcheckout.zip");
  assert.equal(zip.status, 200);
  assert.equal(zip.body.readUInt32LE(0), 0x04034b50);

  const azure = await get(frontPort, "/localcheckoutazure.zip");
  assert.equal(azure.body.toString(), "engine-inner-bytes", "the azure task proxies untouched");

  front.closeAllConnections?.();
  front.close();
  hub.closeAllConnections?.();
  hub.close();
});

test("front: fallback — kill seam and build failure both proxy the engine's original archive", async () => {
  const hub = fakeHub();
  await new Promise<void>((r) => hub.listen(0, r));
  const hubPort = (hub.address() as { port: number }).port;
  const front = startFront({ port: 0, hubPort, uiDir: null });
  const frontPort = (front.address() as { port: number }).port;

  // Seam: the operator (or the live fallback drill) forces the engine's own inner action.
  process.env.NDH_INNER_LOCALCHECKOUT = "engine";
  const forced = await get(frontPort, "/localcheckout.tar.gz");
  assert.equal(forced.body.toString(), "engine-inner-bytes");
  delete process.env.NDH_INNER_LOCALCHECKOUT;

  // Any archive-build failure degrades to the proxy, never to a broken checkout path.
  innerTest.poisonArchiveCache("tarball", {
    get length(): number {
      throw new Error("boom");
    },
  });
  const degraded = await get(frontPort, "/localcheckout.tar.gz");
  assert.equal(degraded.body.toString(), "engine-inner-bytes");

  // Recovery: a healthy build serves the replacement again.
  innerTest.resetArchiveCache();
  const healthy = await get(frontPort, "/localcheckout.tar.gz");
  assert.ok(gunzipSync(healthy.body).includes(Buffer.from("archive/index.js")));

  front.closeAllConnections?.();
  front.close();
  hub.closeAllConnections?.();
  hub.close();
});

test("inner action: serveInnerLocalcheckout writes nothing for non-archive paths", () => {
  const res = new http.ServerResponse({} as http.IncomingMessage);
  assert.equal(serveInnerLocalcheckout("/localcheckout", res), false);
  assert.equal(res.headersSent, false);
});
