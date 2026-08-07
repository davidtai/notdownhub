import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { exists, fail, log } from "./lib.js";

export interface TlsMaterial {
  keyPath: string;
  certPath: string;
  key: Buffer;
  cert: Buffer;
}

/**
 * Self-signed TLS for the hub front. Certificates are minted once with the system
 * openssl (EC P-256, SHA-256, 825 days) with a SAN for the fleet-reachable host,
 * and stored under <hubHome>/tls/. Runners trust the cert file explicitly
 * (`ndh runner join --ca <cert.pem>`), so no CA infrastructure is required.
 */
export async function ensureSelfSignedCert(hubHome: string, host: string): Promise<TlsMaterial> {
  const dir = join(hubHome, "tls");
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  // Regenerate if the stored cert does not cover the current host — otherwise runners that
  // trust the printed cert against the new host would fail verification (SAN mismatch).
  const stale = (await exists(certPath)) && !certCoversHost(certPath, host);
  if (stale) {
    log(`existing certificate does not cover ${host} — regenerating`);
    await rm(keyPath, { force: true });
    await rm(certPath, { force: true });
  }
  if (!(await exists(keyPath)) || !(await exists(certPath))) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const san = isIp(host) ? `IP:${host},DNS:localhost,IP:127.0.0.1` : `DNS:${host},DNS:localhost,IP:127.0.0.1`;
    const r = spawnSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
        "-keyout", keyPath, "-out", certPath,
        "-days", "825", "-nodes", "-sha256",
        "-subj", `/CN=${host}`,
        "-addext", `subjectAltName=${san}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    /* c8 ignore next 3 — openssl-generation failure is a fail-fast guard, not reachable in tests */
    if (r.status !== 0) {
      fail(`openssl certificate generation failed: ${r.stderr?.toString().trim() || r.status}`);
    }
    await chmod(keyPath, 0o600).catch(() => {});
    log(`generated self-signed TLS certificate for ${host} at ${certPath}`);
  }
  return { keyPath, certPath, key: await readFile(keyPath), cert: await readFile(certPath) };
}

/** True when the stored cert's SAN (or CN) includes host. Best-effort text match on openssl output. */
function certCoversHost(certPath: string, host: string): boolean {
  const r = spawnSync("openssl", ["x509", "-in", certPath, "-noout", "-text"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  /* c8 ignore next */
  if (r.status !== 0) return true; // can't read it → don't force a needless regenerate
  // Our certs always list the host in the SAN (see the -addext above), so the SAN is authoritative.
  const san = /X509v3 Subject Alternative Name:\s*\n\s*(.+)/.exec(r.stdout.toString())?.[1] ?? "";
  return san.includes(`DNS:${host}`) || san.includes(`IP Address:${host}`);
}

/** Exposed for tests. */
export const __test = { certCoversHost };

export function certFingerprint(certPath: string): string | null {
  const r = spawnSync("openssl", ["x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  /* c8 ignore next */
  if (r.status !== 0) return null;
  return r.stdout.toString().trim().replace(/^.*=/, "");
}

function isIp(host: string): boolean {
  return isIP(host) !== 0;
}
