import { unwrap } from "./lib.js";
import { getAgentsInfo, readRunMeta, type AgentInfo, type RunMeta } from "./agents-info.js";
import { managementJwt } from "./front.js";
import { localHubTarget, type LocalHubTarget } from "./hub.js";

/**
 * Where the fleet's rich state lives and how a headless-hub operator reaches it (issue #68).
 *
 * The UI renders labels + online/busy/idle/offline from GET /api/local/agents, which is
 * LOOPBACK-gated (and reads the hub's own SQLite DB, so it only works on the hub machine). The
 * CLI must NOT weaken that gate. Instead, when --server points at the hub on THIS machine, the
 * CLI reads the same rich shape directly — via getAgentsInfo + the management-JWT path front.ts
 * uses — with no HTTP gate involved at all. For a genuinely remote hub the rich data is not
 * obtainable without weakening the gate, so we degrade to the proxied _apis view (names only),
 * exactly what `ndh status` showed before.
 */

/** True when a --server URL points at the local machine (so the co-located hub DB is the right one). */
export function isLoopbackUrl(server: string): boolean {
  try {
    const h = new URL(server).hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

async function getJsonDefault(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${new URL(url).pathname}: ${res.status}`);
  return res.json();
}

export interface FleetDeps {
  isLoopback?: (server: string) => boolean;
  localHub?: () => Promise<LocalHubTarget | null>;
  agentsInfo?: (hubPort: number, mint: () => Promise<string | null>) => Promise<AgentInfo[]>;
  mkMint?: (hubPort: number, token?: string) => () => Promise<string | null>;
  getJson?: (url: string) => Promise<unknown>;
  runMeta?: (hubDb?: string) => Promise<Map<number, RunMeta>>;
}

export interface Fleet {
  /** true when the list carries labels + live state (co-located); false for the names-only fallback. */
  rich: boolean;
  agents: AgentInfo[];
}

/** The runner fleet for a --server URL: rich local view when co-located, else proxied names. */
export async function getFleet(server: string, deps: FleetDeps = {}): Promise<Fleet> {
  const loopback = (deps.isLoopback ?? isLoopbackUrl)(server);
  if (loopback) {
    const target = await (deps.localHub ?? localHubTarget)();
    if (target) {
      const mint = (deps.mkMint ?? managementJwt)(target.hubPort, target.runnerToken);
      return { rich: true, agents: await (deps.agentsInfo ?? getAgentsInfo)(target.hubPort, mint) };
    }
  }
  // Fallback: the hub's proxied Agent API over the network — names (and whatever labels it
  // exposes, currently none), no live state. A connection failure propagates for #69 handling.
  const getJson = deps.getJson ?? getJsonDefault;
  const base = server.endsWith("/") ? server : `${server}/`;
  const agents: AgentInfo[] = [];
  for (const pool of unwrap<{ id: number }>(await getJson(`${base}_apis/v1/AgentPools`))) {
    for (const a of unwrap<{ name?: string; labels?: { name?: string }[] }>(await getJson(`${base}_apis/v1/Agent/${pool.id}`))) {
      if (!a.name) continue;
      agents.push({
        name: a.name,
        labels: (a.labels ?? []).map((l) => l.name).filter((n): n is string => !!n),
        online: false,
        busy: false,
        state: "offline",
        ephemeral: false,
      });
    }
  }
  return { rich: false, agents };
}

/** Per-run execution metadata for a --server URL — only from the co-located hub DB; else empty. */
export async function getRunMeta(server: string, deps: FleetDeps = {}): Promise<Map<number, RunMeta>> {
  if (!(deps.isLoopback ?? isLoopbackUrl)(server)) return new Map();
  const target = await (deps.localHub ?? localHubTarget)();
  if (!target) return new Map();
  return (deps.runMeta ?? readRunMeta)();
}

/** Human runner-state label for a rich agent: "online, busy" | "online, idle" | "offline". */
export function stateLabel(a: Pick<AgentInfo, "state">): string {
  return a.state === "active" ? "online, busy" : a.state === "idle" ? "online, idle" : "offline";
}
