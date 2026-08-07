import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { ensureSelfSignedCert, certFingerprint } from "../tls.js";
import { prepareHub } from "../hub.js";
import { startFront } from "../front.js";
import { __test as runnerTest } from "../runner.js";

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ndh-tls-test-"));
  process.env.NDH_HOME = home;
  return home;
}

test("ensureSelfSignedCert: generates once, reuses after, fingerprint readable", async () => {
  const home = freshHome();
  const hubHome = join(home, "hub");
  const m1 = await ensureSelfSignedCert(hubHome, "192.168.9.9");
  assert.ok(m1.cert.toString().includes("BEGIN CERTIFICATE"));
  assert.ok(m1.key.toString().includes("PRIVATE KEY"));
  assert.equal(statSync(m1.keyPath).mode & 0o777, 0o600);

  const fp = certFingerprint(m1.certPath);
  assert.ok(fp && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(fp), `fingerprint format: ${fp}`);

  // Same host → material is reused, not regenerated.
  const m2 = await ensureSelfSignedCert(hubHome, "192.168.9.9");
  assert.equal(m2.cert.toString(), m1.cert.toString(), "same host reuses the existing certificate");

  // Different host not covered by the SAN → regenerate, so runners trusting the printed cert
  // against the new host do not hit a SAN mismatch.
  const m3 = await ensureSelfSignedCert(hubHome, "10.0.0.5");
  assert.notEqual(m3.cert.toString(), m1.cert.toString(), "a host not in the SAN forces a fresh certificate");
});

test("ensureSelfSignedCert: DNS hostname SAN reuse and change", async () => {
  const home = freshHome();
  const hubHome = join(home, "hub");
  const a = await ensureSelfSignedCert(hubHome, "hub.local");
  const b = await ensureSelfSignedCert(hubHome, "hub.local");
  assert.equal(b.cert.toString(), a.cert.toString(), "same DNS host reuses the certificate");
  const c = await ensureSelfSignedCert(hubHome, "other.local");
  assert.notEqual(c.cert.toString(), a.cert.toString(), "a different DNS host regenerates");
});

test("certCoversHost: matches IP + DNS SANs and CN, rejects others", async () => {
  const { __test } = await import("../tls.js");
  const home = freshHome();
  const hubHome = join(home, "hub");
  const ipCert = await ensureSelfSignedCert(hubHome, "192.168.5.5");
  assert.ok(__test.certCoversHost(ipCert.certPath, "192.168.5.5"), "IP in SAN matches");
  assert.ok(__test.certCoversHost(ipCert.certPath, "127.0.0.1"), "loopback IP is always in the SAN");
  assert.ok(!__test.certCoversHost(ipCert.certPath, "10.9.9.9"), "an unlisted IP does not match");

  const dnsHome = join(home, "hub2");
  const dnsCert = await ensureSelfSignedCert(dnsHome, "hub.example");
  assert.ok(__test.certCoversHost(dnsCert.certPath, "hub.example"), "DNS host in SAN matches");
  assert.ok(!__test.certCoversHost(dnsCert.certPath, "other.example"), "an unlisted DNS host does not match");
});

test("resolveTls: none / self-signed / bring-your-own", async () => {
  const { resolveTls } = await import("../hub.js");
  const home = freshHome();
  const hubHome = join(home, "hub");

  // no --tls → undefined
  assert.equal(await resolveTls({ tls: false }, hubHome, "h", "http://h"), undefined);

  // self-signed
  const self = await resolveTls({ tls: true }, hubHome, "127.0.0.1", "https://127.0.0.1");
  assert.ok(self && self.cert.toString().includes("BEGIN CERTIFICATE") && self.key.toString().includes("PRIVATE KEY"));

  // bring-your-own: reuse the just-generated files as caller-supplied cert/key
  const byo = await resolveTls(
    { tls: true, tlsCert: join(hubHome, "tls", "cert.pem"), tlsKey: join(hubHome, "tls", "key.pem") },
    hubHome,
    "127.0.0.1",
    "https://127.0.0.1",
  );
  assert.ok(byo && byo.cert.toString().includes("BEGIN CERTIFICATE"));
});

test("prepareHub with tls: scheme https, default port 443, origin elides :443, mirror URLs https", async () => {
  freshHome();
  const plan = await prepareHub({
    hubPort: "5980",
    auth: false,
    mirrorRewrite: true,
    ui: false,
    host: "hub.example",
    tls: true,
  });
  assert.equal(plan.scheme, "https");
  assert.equal(plan.port, 443);
  assert.equal(plan.origin, "https://hub.example");
  assert.equal(
    plan.env["Runner.Server__ActionDownloadUrls__0__TarballUrl"],
    "https://hub.example/mirror/{0}/tarball/{1}",
  );

  const explicit = await prepareHub({
    port: "8443",
    hubPort: "5980",
    auth: false,
    mirrorRewrite: true,
    ui: false,
    host: "hub.example",
    tls: true,
  });
  assert.equal(explicit.port, 8443);
  assert.equal(explicit.origin, "https://hub.example:8443");

  const plain = await prepareHub({ hubPort: "5980", auth: false, mirrorRewrite: false, ui: false, host: "h" });
  assert.equal(plain.scheme, "http");
  assert.equal(plain.port, 4949);
  assert.equal(plain.origin, "http://h:4949");
});

test("startFront with tls: serves HTTPS that a client trusting the cert can call", async () => {
  const home = freshHome();
  const material = await ensureSelfSignedCert(join(home, "hub"), "127.0.0.1");
  const server = startFront({
    port: 0,
    hubPort: 1, // no hub behind it; join-info does not need one
    uiDir: null,
    runnerToken: "tok",
    host: "127.0.0.1",
    tls: { key: material.key, cert: material.cert },
  });
  await new Promise<void>((r) => server.on("listening", () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const port = addr.port;

  const body = await new Promise<string>((resolve, reject) => {
    https
      .get(
        { host: "127.0.0.1", port, path: "/api/local/join-info", ca: material.cert },
        (res) => {
          assert.equal(res.statusCode, 200);
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => resolve(data));
        },
      )
      .on("error", reject);
  });
  const info = JSON.parse(body) as { token: string };
  assert.equal(info.token, "tok");
  server.close();
});

test("runner join --ca: certificate stored and trust env applied to configure and start", async () => {
  const home = freshHome();
  const material = await ensureSelfSignedCert(join(home, "hub"), "127.0.0.1");

  const seen: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const deps = {
    ensure: async () => 0,
    run: async (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      seen.push({ cmd, args, env: opts?.env });
      return 0;
    },
    copyVendor: async (dir: string) => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(runnerTest.listenerExe(dir), "#!/bin/sh\n", { mode: 0o755 });
    },
  };

  const code = await runnerTest.join_(
    "https://hub.example",
    { name: "tls-node", labels: "self-hosted", token: "t", ca: material.certPath },
    deps,
  );
  assert.equal(code, 0);
  const configure = seen[0];
  assert.equal(configure.args[0], "configure");
  const urlIdx = configure.args.indexOf("--url");
  assert.equal(configure.args[urlIdx + 1], "https://hub.example/runner/server");
  const storedCa = join(home, "runners", "tls-node", "ca.pem");
  assert.equal(configure.env?.SSL_CERT_FILE, storedCa);
  assert.equal(configure.env?.NODE_EXTRA_CA_CERTS, storedCa);

  const startCode = await runnerTest.start("tls-node", deps);
  assert.equal(startCode, 0);
  const runCall = seen[1];
  assert.deepEqual(runCall.args, ["run"]);
  assert.equal(runCall.env?.SSL_CERT_FILE, storedCa);
});
