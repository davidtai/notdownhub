/**
 * ndh-owned localcheckout shim (issue #98).
 *
 * When a dispatched local repo's workflow uses actions/checkout, the engine swaps the step for a
 * generic "localcheckout" composite action it serves at
 * /_apis/v1/ActionDownloadInfo/localcheckout?format=&version=&name= (an embedded resource in
 * Runner.Server.dll). That composite's own inner step passes `fetch-tags` to the engine's static
 * inner action (wwwroot/localcheckout.tar.gz), whose action.yml declares an older checkout input
 * surface — so EVERY localcheckout run gets an "Unexpected input(s) 'fetch-tags'" warning
 * annotation, and modern inputs (sparse-checkout, filter, ...) are silently ignored on the local
 * path (the composite forwards them only to the remote-fallback step).
 *
 * The engine offers no override hook, and the vendor bundle must stay pristine. But every runner
 * downloads actions THROUGH the ndh front (the hub mints action URLs from the Host header), so the
 * front intercepts that one GET and serves this ndh-owned composite instead:
 *   - declares actions/checkout@v4's full input surface (plus the shim's own `checkoutref`);
 *   - the inner local step passes ONLY inputs the engine's inner action declares — no warning;
 *   - a post step on the local path implements what makes sense for a copied local tree
 *     (fetch-tags via the copied .git, sparse-checkout via `git sparse-checkout set`,
 *     set-safe-directory) and logs ONE explicit line for each input that is inherently N/A;
 *   - the remote-fallback step is byte-for-byte upstream semantics (real checkout gets everything).
 *
 * The inner step must reference actions/checkout@<engine commit SHA> — that exact ref is what the
 * engine resolves to its static inner action. The SHA is build-specific, so it is discovered once
 * per process from the hub's own upstream composite and cached; on any failure the caller proxies
 * the request through unchanged (pre-#98 behavior).
 */
import http from "node:http";
import { gzipSync, gunzipSync } from "node:zlib";

/** Placeholders match upstream's template so the substitution contract is identical. */
export const LOCALCHECKOUT_TEMPLATE = `name: 'localcheckout'
description: 'Checks out the current changes of a local repo. Input surface matches actions/checkout@v4.'
inputs:
  repository:
    description: 'Repository name with owner. For example, actions/checkout'
    default: \${{ github.repository }}
  ref:
    description: 'The branch, tag or SHA to checkout.'
  token:
    description: 'Personal access token (PAT) used to fetch the repository.'
    default: \${{ github.token }}
  ssh-key:
    description: 'SSH key used to fetch the repository.'
  ssh-known-hosts:
    description: 'Known hosts in addition to the user and global host key database.'
  ssh-strict:
    description: 'Whether to perform strict host key checking.'
    default: true
  ssh-user:
    description: 'The user to use when connecting to the remote SSH host.'
    default: git
  persist-credentials:
    description: 'Whether to configure the token or SSH key with the local git config.'
    default: true
  path:
    description: 'Relative path under $GITHUB_WORKSPACE to place the repository.'
  clean:
    description: 'Whether to execute git clean -ffdx && git reset --hard HEAD before fetching.'
    default: true
  filter:
    description: 'Partially clone against a given filter. N/A for a local checkout: the full tree is copied. Ignored with a log line.'
    default: null
  sparse-checkout:
    description: 'Do a sparse checkout on given patterns, one per line. Applied to the local copy with git sparse-checkout.'
    default: null
  sparse-checkout-cone-mode:
    description: 'Whether to use cone-mode when doing a sparse checkout.'
    default: true
  fetch-depth:
    description: 'Number of commits to fetch. 0 indicates all history for all branches and tags.'
    default: 1
  fetch-tags:
    description: 'Whether to fetch tags. A local checkout copies .git, so local tags are already present; logged.'
    default: false
  show-progress:
    description: 'Whether to show progress status output when fetching. N/A for a local checkout: no network fetch. Ignored with a log line.'
    default: true
  lfs:
    description: 'Whether to download Git-LFS files.'
    default: false
  submodules:
    description: 'Whether to checkout submodules: true to checkout submodules or recursive to recursively checkout submodules.'
    default: false
  set-safe-directory:
    description: 'Add repository path as safe.directory for Git global config.'
    default: true
  github-server-url:
    description: 'Base URL for the GitHub instance to clone from. N/A for a local checkout. Ignored with a log line.'
    required: false
  checkoutref:
    description: 'Internal: the actions/checkout ref this shim replaced (set by the hub).'
    default: '_____REF_____'
runs:
  using: composite
  steps:
  - uses: _____checkout_____@_____SHA_____
    id: local
    with:
      repository: \${{ inputs.repository }}
      ref: \${{ inputs.ref }}
      token: \${{ inputs.token }}
      ssh-key: \${{ inputs.ssh-key }}
      ssh-known-hosts: \${{ inputs.ssh-known-hosts }}
      ssh-strict: \${{ inputs.ssh-strict }}
      persist-credentials: \${{ inputs.persist-credentials }}
      path: \${{ inputs.path }}
      clean: \${{ inputs.clean }}
      fetch-depth: \${{ inputs.fetch-depth }}
      lfs: \${{ inputs.lfs }}
      submodules: \${{ inputs.submodules }}
      checkoutref: \${{ inputs.checkoutref }}
  - name: Apply checkout inputs to the local copy
    if: fromJSON(steps.local.outputs.skip)
    shell: bash
    env:
      NDH_PATH: \${{ inputs.path }}
      NDH_FETCH_TAGS: \${{ inputs.fetch-tags }}
      NDH_SPARSE: \${{ inputs.sparse-checkout }}
      NDH_SPARSE_CONE: \${{ inputs.sparse-checkout-cone-mode }}
      NDH_FILTER: \${{ inputs.filter }}
      NDH_SHOW_PROGRESS: \${{ inputs.show-progress }}
      NDH_SET_SAFE_DIRECTORY: \${{ inputs.set-safe-directory }}
      NDH_SERVER_URL: \${{ inputs.github-server-url }}
      NDH_SSH_USER: \${{ inputs.ssh-user }}
    run: |
      # notdownhub localcheckout: checkout@v4 inputs against a copied local tree (#98).
      dest="$GITHUB_WORKSPACE"
      if [ -n "$NDH_PATH" ]; then dest="$GITHUB_WORKSPACE/$NDH_PATH"; fi
      cd "$dest"
      if [ "$NDH_SET_SAFE_DIRECTORY" != "false" ] && [ -e .git ]; then
        git config --global --add safe.directory "$dest"
        echo "set-safe-directory: added $dest to the global git config"
      fi
      if [ "$NDH_FETCH_TAGS" = "true" ]; then
        if [ -e .git ]; then
          echo "fetch-tags: the local checkout copies .git, $(git tag | wc -l | tr -d ' ') tag(s) already available"
        else
          echo "fetch-tags: the local copy has no .git directory, nothing to fetch; ignored"
        fi
      fi
      if [ -n "$(printf '%s' "$NDH_SPARSE" | tr -d '[:space:]')" ]; then
        if [ -e .git ]; then
          cone=""
          if [ "$NDH_SPARSE_CONE" = "false" ]; then cone="--no-cone"; fi
          # The copied index carries stale stat info (file mtimes changed in transit), which
          # makes clean files look modified — refresh first so only REAL local edits are kept.
          git status --porcelain > /dev/null
          printf '%s\\n' "$NDH_SPARSE" | sed -e 's/\\r$//' -e '/^[[:space:]]*$/d' | git sparse-checkout set $cone --stdin
          echo "sparse-checkout: applied to the local copy (cone-mode=$NDH_SPARSE_CONE); files with local modifications are kept"
        else
          echo "sparse-checkout: the local copy has no .git directory; ignored"
        fi
      fi
      if [ -n "$NDH_FILTER" ]; then echo "filter: N/A for a local checkout (the full tree is copied); ignored"; fi
      if [ "$NDH_SHOW_PROGRESS" = "false" ]; then echo "show-progress: N/A for a local checkout (no network fetch); ignored"; fi
      if [ -n "$NDH_SERVER_URL" ]; then echo "github-server-url: N/A for a local checkout; ignored"; fi
      if [ -n "$NDH_SSH_USER" ] && [ "$NDH_SSH_USER" != "git" ]; then echo "ssh-user: N/A for a local checkout; ignored"; fi
  - uses: _____checkout_____@_____SHA__________REF_____
    if: "!fromJSON(steps.local.outputs.skip)"
    id: remote
    with:
      repository: \${{ inputs.repository }}
      ref: \${{ inputs.ref }}
      token: \${{ inputs.token }}
      ssh-key: \${{ inputs.ssh-key }}
      ssh-known-hosts: \${{ inputs.ssh-known-hosts }}
      ssh-strict: \${{ inputs.ssh-strict }}
      ssh-user: \${{ inputs.ssh-user }}
      persist-credentials: \${{ inputs.persist-credentials }}
      path: \${{ inputs.path }}
      clean: \${{ inputs.clean }}
      filter: \${{ inputs.filter }}
      sparse-checkout: \${{ inputs.sparse-checkout }}
      sparse-checkout-cone-mode: \${{ inputs.sparse-checkout-cone-mode }}
      fetch-depth: \${{ inputs.fetch-depth }}
      fetch-tags: \${{ inputs.fetch-tags }}
      show-progress: \${{ inputs.show-progress }}
      lfs: \${{ inputs.lfs }}
      submodules: \${{ inputs.submodules }}
      set-safe-directory: \${{ inputs.set-safe-directory }}
      github-server-url: \${{ inputs.github-server-url }}
outputs:
  ref:
    description: 'The branch, tag or SHA that was checked out'
    value: \${{ steps.remote.outputs.ref }}
  commit:
    description: 'The commit SHA that was checked out'
    value: \${{ steps.remote.outputs.commit }}
`;

/** Substitute the engine's placeholders exactly like GetLocalCheckout does upstream. */
export function renderLocalcheckout(engineSha: string, version: string, name: string): string {
  return LOCALCHECKOUT_TEMPLATE.replaceAll("_____SHA_____", engineSha)
    .replaceAll("_____REF_____", version)
    .replaceAll("_____checkout_____", name);
}

export interface ArchiveEntry {
  name: string;
  data: Buffer;
}

/** Minimal ustar writer — one top-level dir + small text files, exactly what the runner expects. */
export function buildTarGz(entries: ArchiveEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, typeflag: string): Buffer => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000755", 100, 8, "ascii"); // mode
    h.write("0000000", 108, 8, "ascii"); // uid
    h.write("0000000", 116, 8, "ascii"); // gid
    h.write(size.toString(8).padStart(11, "0"), 124, 12, "ascii");
    h.write("00000000000", 136, 12, "ascii"); // mtime
    h.write("        ", 148, 8, "ascii"); // chksum placeholder = spaces
    h.write(typeflag, 156, 1, "ascii");
    h.write("ustar", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    return h;
  };
  // A single top-level dir entry first: the runner strips the archive's root directory.
  blocks.push(header("archive/", 0, "5"));
  for (const e of entries) {
    blocks.push(header(`archive/${e.name}`, e.data.length, "0"), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return gzipSync(Buffer.concat(blocks));
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal stored (no compression) zip writer — the Windows runner requests zipball. */
export function buildZip(entries: ArchiveEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const all: ArchiveEntry[] = [{ name: "", data: Buffer.alloc(0) }, ...entries]; // "" => root dir entry
  for (const e of all) {
    const name = Buffer.from(`archive/${e.name}`, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, e.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 10); // method
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + e.data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(all.length, 8);
  eocd.writeUInt16LE(all.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** Pull the engine's build commit SHA out of its own rendered composite (a .tar.gz of action.yml). */
export function extractEngineSha(tarGz: Buffer): string | null {
  try {
    const text = gunzipSync(tarGz).toString("latin1");
    return text.match(/@([0-9a-f]{40})/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function get(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    http
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", () => resolve(null));
      })
      .on("error", () => resolve(null));
  });
}

/** Successful discoveries only — a hub that is still starting up must not poison the cache. */
const shaCache = new Map<number, string>();

export async function discoverEngineSha(hubPort: number): Promise<string | null> {
  const cached = shaCache.get(hubPort);
  if (cached) return cached;
  const body = await get(
    `http://127.0.0.1:${hubPort}/_apis/v1/ActionDownloadInfo/localcheckout?format=tarball&version=v4&name=${encodeURIComponent("actions/checkout")}`,
  );
  const sha = body ? extractEngineSha(body) : null;
  if (sha) shaCache.set(hubPort, sha);
  return sha;
}

/**
 * Serve the ndh composite for GET .../ActionDownloadInfo/localcheckout. Returns false — with
 * nothing written — when the request is not renderable (missing params, SHA discovery failed),
 * so the caller can proxy the engine's own shim instead.
 */
export async function serveLocalcheckout(
  hubPort: number,
  url: URL,
  res: http.ServerResponse,
): Promise<boolean> {
  const format = url.searchParams.get("format");
  const version = url.searchParams.get("version");
  const name = url.searchParams.get("name");
  if (!version || !name || (format !== "tarball" && format !== "zipball")) return false;
  const sha = await discoverEngineSha(hubPort);
  if (!sha) return false;
  const yml = Buffer.from(renderLocalcheckout(sha, version, name), "utf8");
  const archive =
    format === "tarball" ? buildTarGz([{ name: "action.yml", data: yml }]) : buildZip([{ name: "action.yml", data: yml }]);
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length });
  res.end(archive);
  return true;
}

export const __test = {
  resetShaCache: () => shaCache.clear(),
};
