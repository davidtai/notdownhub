import { backendName, listSecrets } from "./secrets.js";
import { listVars } from "./vars.js";

/**
 * Read-only view of this hub's secrets and variables for the Settings page.
 * Secret *names* are listed (never their values — those stay in the OS keyring /
 * encrypted file); variables are non-sensitive, so their values are included.
 */
export interface ConfigInfo {
  backend: string;
  secrets: { scope: string; name: string }[];
  vars: { scope: string; name: string; value: string }[];
}

export async function getConfigInfo(): Promise<ConfigInfo> {
  const [secrets, vars] = await Promise.all([listSecrets(), listVars()]);
  return {
    backend: backendName(),
    secrets: secrets.map((s) => ({ scope: s.scope, name: s.name })),
    vars,
  };
}
