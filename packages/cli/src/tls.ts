import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
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
    if (r.status !== 0) {
      fail(`openssl certificate generation failed: ${r.stderr?.toString().trim() || r.status}`);
    }
    spawnSync("chmod", ["600", keyPath], { stdio: "ignore" });
    log(`generated self-signed TLS certificate for ${host} at ${certPath}`);
  }
  return { keyPath, certPath, key: await readFile(keyPath), cert: await readFile(certPath) };
}

export function certFingerprint(certPath: string): string | null {
  const r = spawnSync("openssl", ["x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return null;
  return r.stdout.toString().trim().replace(/^.*=/, "");
}

function isIp(host: string): boolean {
  return isIP(host) !== 0;
}
