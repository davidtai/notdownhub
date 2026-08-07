import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import {
  LOCALCHECKOUT_TEMPLATE,
  renderLocalcheckout,
  buildTarGz,
  buildZip,
  crc32,
  extractEngineSha,
  discoverEngineSha,
  serveLocalcheckout,
  __test as lcTest,
} from "../localcheckout.js";
import { startFront } from "../front.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";

function render(): string {
  return renderLocalcheckout(SHA, "v4", "actions/checkout");
}

afterEach(() => lcTest.resetShaCache());

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, r));
  return (server.address() as { port: number }).port;
}

function req(port: number, path: string): Promise<{ status: number; body: Buffer; type?: string }> {
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

// ---- template + rendering -------------------------------------------------------------------

test("localcheckout: render substitutes every placeholder like the engine does", () => {
  const yml = render();
  assert.ok(!yml.includes("_____"), "no placeholder may survive rendering");
  // Inner local step: the engine resolves checkout@<engine sha> to its static inner action.
  assert.ok(yml.includes(`- uses: actions/checkout@${SHA}\n`));
  // Remote fallback: <engine sha><user ref> strips back to the real actions/checkout@v4.
  assert.ok(yml.includes(`- uses: actions/checkout@${SHA}v4\n`));
  // The shim's own ref rides through as the checkoutref default.
  assert.ok(yml.includes("default: 'v4'"));
});

test("localcheckout: declares the full actions/checkout@v4 input surface plus checkoutref", () => {
  const v4Inputs = [
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
  const inputsBlock = LOCALCHECKOUT_TEMPLATE.slice(
    LOCALCHECKOUT_TEMPLATE.indexOf("inputs:"),
    LOCALCHECKOUT_TEMPLATE.indexOf("runs:"),
  );
  for (const name of v4Inputs) {
    assert.ok(new RegExp(`^  ${name}:`, "m").test(inputsBlock), `input '${name}' must be declared`);
  }
});

test("localcheckout: the inner local step passes only inputs the engine's inner action declares", () => {
  // THE #98 fix: upstream's composite passes fetch-tags to an inner action that does not declare
  // it, which raises "Unexpected input(s) 'fetch-tags'" on every localcheckout run.
  const yml = render();
  const local = yml.slice(yml.indexOf("id: local"), yml.indexOf("name: Apply checkout inputs"));
  const innerDeclared = [
    "repository",
    "ref",
    "token",
    "ssh-key",
    "ssh-known-hosts",
    "ssh-strict",
    "persist-credentials",
    "path",
    "clean",
    "fetch-depth",
    "lfs",
    "submodules",
    "checkoutref",
  ];
  const passed = [...local.matchAll(/^ {6}([a-z-]+):/gm)].map((m) => m[1]);
  assert.deepEqual(passed.sort(), [...innerDeclared].sort());
  assert.ok(!passed.includes("fetch-tags"), "fetch-tags must never reach the inner action");
});

test("localcheckout: remote fallback still forwards the full surface to real actions/checkout", () => {
  const yml = render();
  const remote = yml.slice(yml.indexOf("id: remote"), yml.indexOf("outputs:"));
  for (const name of ["fetch-tags", "sparse-checkout", "filter", "show-progress", "set-safe-directory", "github-server-url"]) {
    assert.ok(remote.includes(`${name}: \${{ inputs.${name} }}`), `remote step must forward '${name}'`);
  }
});

test("localcheckout: local-path step implements the cheap inputs and logs each N/A input once", () => {
  const yml = render();
  const script = yml.slice(yml.indexOf("run: |"), yml.indexOf("- uses: actions/checkout@" + SHA + "v4"));
  // Implemented against the copied tree.
  assert.ok(script.includes("git sparse-checkout set"), "sparse-checkout is implemented via git");
  assert.ok(script.includes("--no-cone"), "cone-mode toggle is honored");
  assert.ok(script.includes("git config --global --add safe.directory"), "set-safe-directory is implemented");
  assert.ok(script.includes("fetch-tags: the local checkout copies .git"), "fetch-tags reports tag availability");
  // Inherently-N/A inputs: exactly one explicit log line each.
  for (const line of [
    "filter: N/A for a local checkout",
    "show-progress: N/A for a local checkout",
    "github-server-url: N/A for a local checkout",
    "ssh-user: N/A for a local checkout",
  ]) {
    assert.equal(script.split(line).length - 1, 1, `one log line for: ${line}`);
  }
  // The step only runs when the LOCAL copy succeeded.
  assert.ok(yml.includes("if: fromJSON(steps.local.outputs.skip)"));
});

// ---- archive builders -----------------------------------------------------------------------

test("localcheckout: tar.gz round-trips and the engine SHA is recoverable from it", () => {
  const tgz = buildTarGz([{ name: "action.yml", data: Buffer.from(render()) }]);
  assert.equal(extractEngineSha(tgz), SHA);
  const raw = gunzipSync(tgz);
  // ustar header for the root dir the runner strips, then the file entry.
  assert.equal(raw.subarray(0, 8).toString("ascii").replace(/\0.*$/, ""), "archive/");
  assert.equal(raw.subarray(257, 262).toString("ascii"), "ustar");
  assert.ok(raw.includes(Buffer.from("archive/action.yml")));
  assert.ok(raw.length % 512 === 0, "tar stream is block-aligned");
});

test("localcheckout: extractEngineSha rejects non-gzip and sha-less archives", () => {
  assert.equal(extractEngineSha(Buffer.from("not gzip")), null);
  assert.equal(extractEngineSha(buildTarGz([{ name: "action.yml", data: Buffer.from("no sha here") }])), null);
});

test("localcheckout: crc32 matches the reference vector", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("localcheckout: zip is a valid stored archive (signatures, EOCD, payload)", () => {
  const data = Buffer.from(render());
  const zip = buildZip([{ name: "action.yml", data }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "local file header signature");
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, "end-of-central-directory signature");
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2, "two entries: root dir + action.yml");
  assert.ok(zip.includes(Buffer.from("archive/action.yml")));
  assert.ok(zip.includes(data), "stored (uncompressed) payload is embedded verbatim");
});

// ---- SHA discovery --------------------------------------------------------------------------

function fakeHub(handler: http.RequestListener) {
  let hits = 0;
  const server = http.createServer((rq, rs) => {
    hits++;
    handler(rq, rs);
  });
  return { server, get hits() { return hits; } };
}

const upstreamTarball = () =>
  buildTarGz([{ name: "action.yml", data: Buffer.from(`steps:\n  - uses: actions/checkout@${SHA}\n`) }]);

test("localcheckout: discoverEngineSha reads the hub's own composite once, then caches", async () => {
  const hub = fakeHub((_rq, rs) => {
    rs.writeHead(200);
    rs.end(upstreamTarball());
  });
  const port = await listen(hub.server);
  assert.equal(await discoverEngineSha(port), SHA);
  assert.equal(await discoverEngineSha(port), SHA);
  assert.equal(hub.hits, 1, "second lookup is served from the cache");
  hub.server.close();
});

test("localcheckout: discovery failure is not cached — the next attempt retries", async () => {
  let ok = false;
  const hub = fakeHub((_rq, rs) => {
    if (!ok) {
      rs.writeHead(503);
      rs.end();
    } else {
      rs.writeHead(200);
      rs.end(upstreamTarball());
    }
  });
  const port = await listen(hub.server);
  assert.equal(await discoverEngineSha(port), null);
  ok = true;
  assert.equal(await discoverEngineSha(port), SHA);
  hub.server.close();
});

test("localcheckout: discovery survives an unreachable hub", async () => {
  const hub = fakeHub((_rq, rs) => rs.end());
  const port = await listen(hub.server);
  hub.server.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await discoverEngineSha(port), null);
});

// ---- serving through the front --------------------------------------------------------------

test("localcheckout: serveLocalcheckout writes nothing for unrenderable requests", async () => {
  const res = new http.ServerResponse({} as http.IncomingMessage);
  const bad = new URL("http://x/_apis/v1/ActionDownloadInfo/localcheckout?format=tarball");
  assert.equal(await serveLocalcheckout(1, bad, res), false);
  const badFormat = new URL("http://x/_apis/v1/ActionDownloadInfo/localcheckout?format=exe&version=v4&name=actions%2Fcheckout");
  assert.equal(await serveLocalcheckout(1, badFormat, res), false);
  assert.equal(res.headersSent, false);
});

test("front: GET ActionDownloadInfo/localcheckout serves the ndh composite (tarball + zipball)", async () => {
  const hub = fakeHub((_rq, rs) => {
    rs.writeHead(200);
    rs.end(upstreamTarball());
  });
  const hubPort = await listen(hub.server);
  const front = startFront({ port: 0, hubPort, uiDir: null });
  const frontPort = (front.address() as { port: number }).port;

  const tar = await req(frontPort, "/_apis/v1/ActionDownloadInfo/localcheckout?format=tarball&version=v4&name=actions%2Fcheckout");
  assert.equal(tar.status, 200);
  assert.equal(tar.type, "application/octet-stream");
  const yml = gunzipSync(tar.body).toString("utf8");
  assert.ok(yml.includes("fetch-tags:"), "served composite declares the modern surface");
  assert.ok(yml.includes(`actions/checkout@${SHA}`), "inner step pins the discovered engine SHA");
  assert.ok(yml.includes("default: 'v4'"), "requested version rides through");

  // Tenant-prefixed route shape ({owner}/{repo}/_apis/...) is intercepted too.
  const tenant = await req(frontPort, "/o/r/_apis/v1/ActionDownloadInfo/localcheckout?format=tarball&version=v3&name=actions%2Fcheckout");
  assert.equal(tenant.status, 200);
  assert.ok(gunzipSync(tenant.body).toString("utf8").includes("default: 'v3'"));

  const zip = await req(frontPort, "/_apis/v1/ActionDownloadInfo/localcheckout?format=zipball&version=v4&name=actions%2Fcheckout");
  assert.equal(zip.status, 200);
  assert.equal(zip.body.readUInt32LE(0), 0x04034b50, "zipball responses are zip archives");

  front.closeAllConnections?.();
  front.close();
  hub.server.close();
});

test("front: falls back to proxying the engine's shim when it cannot render one", async () => {
  const marker = "engine-shim-bytes";
  const hub = fakeHub((rq, rs) => {
    // Discovery gets junk (no recoverable SHA); the proxied request gets the marker body.
    rs.writeHead(200);
    rs.end(rq.headers["x-proxied"] ? marker : "not-a-tarball");
  });
  const hubPort = await listen(hub.server);
  const front = startFront({ port: 0, hubPort, uiDir: null });
  const frontPort = (front.address() as { port: number }).port;

  // SHA discovery fails → the request must stream through to the hub untouched.
  const viaProxy = await new Promise<string>((resolve, reject) => {
    http
      .get(
        {
          host: "127.0.0.1",
          port: frontPort,
          path: "/_apis/v1/ActionDownloadInfo/localcheckout?format=tarball&version=v4&name=actions%2Fcheckout",
          headers: { "x-proxied": "1" },
          agent: false,
        },
        (rs) => {
          let b = "";
          rs.on("data", (d) => (b += d));
          rs.on("end", () => resolve(b));
        },
      )
      .on("error", reject);
  });
  assert.equal(viaProxy, marker);

  // Malformed query (no version/name) proxies without even attempting discovery.
  const noParams = await req(frontPort, "/_apis/v1/ActionDownloadInfo/localcheckout?format=tarball");
  assert.equal(noParams.body.toString(), "not-a-tarball");

  front.closeAllConnections?.();
  front.close();
  hub.server.close();
});
