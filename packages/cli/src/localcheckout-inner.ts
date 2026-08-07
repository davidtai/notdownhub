/**
 * ndh-owned INNER localcheckout action (issue #107).
 *
 * The engine's outer localcheckout composite pins its inner step to
 * actions/checkout@<engine build SHA>. For that exact ref the hub mints download URLs pointing at
 * its static wwwroot files — <ServerUrl>/localcheckout.tar.gz (tarball) and /localcheckout.zip
 * (zipball), see ActionDownloadInfoController upstream. That static bundle is a node16 action
 * carrying an ancient @actions/core, so EVERY localcheckout run emits the
 * "set-output command is deprecated" warning annotation — which stamps "Passed with warnings" on
 * runs that are perfectly clean (#62 noise).
 *
 * ServerUrl is minted from the Host header, so runners fetch that static file THROUGH the ndh
 * front (the same #34 always-proxy path). Exactly like #106 did for the outer composite, the
 * front intercepts the GET and serves this ndh-owned replacement instead:
 *   - identical protocol: streams the dispatching machine's working tree (including .git) from
 *     the hub's multipart endpoint and writes it into the workspace;
 *   - modern output handling: the `skip` output is appended to the GITHUB_OUTPUT env file (the
 *     mechanism current @actions/core uses) — no ::set-output anywhere;
 *   - dependency-free single-file JS (no node_modules bundle): hand-written input/output/command
 *     helpers and a streaming multipart parser matched to the one producer that exists
 *     (.NET MultipartFormDataContent in Runner.Client);
 *   - node20 runtime (the vendored runner's default internal node; node16 is EOL);
 *   - declares the FULL checkout@v4 input surface plus checkoutref, so it stays warning-free
 *     under BOTH outer composites (ndh's passes 13 inputs, the engine's adds fetch-tags).
 *
 * Fallback discipline (#106 parity): on any failure to build/serve the replacement — or when
 * NDH_INNER_LOCALCHECKOUT=engine forces it — the front proxies the engine's original static
 * archive unchanged. Degraded means the old cosmetic warning returns; checkout never breaks.
 *
 * #111 (live regression, run #15): the first real-tree run produced a silent near-empty checkout.
 * Root cause: any part bigger than the writer's 16KB highWaterMark makes ws.write() return false,
 * which paused the source and armed resume on 'drain' alone. When that part's closing boundary is
 * already buffered, endPart() calls ws.end() in the same synchronous pump — and Node NEVER emits
 * 'drain' after end() (afterWrite checks !state.ending). The source stayed paused forever, a
 * paused socket does not hold the event loop, so node exited 0 with a partial tree and skip=true
 * already written. Fixed by also arming resume on 'close'/'error', and by making every outcome
 * explicit: the step now FAILS unless the stream completed, every entry parsed and wrote cleanly,
 * at least one file materialized, and a .git-carrying stream produced a .git directory.
 */
import http from "node:http";
import { buildTarGz, buildZip, type ArchiveEntry } from "./localcheckout.js";

/** Full checkout@v4 surface + checkoutref: a superset of what either outer composite passes. */
export const INNER_ACTION_YML = `name: 'localcheckout'
description: 'Copies the dispatched local working tree (including .git) from the notdownhub hub.'
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
    description: 'Whether to empty the destination before copying the tree.'
    default: true
  filter:
    description: 'Partially clone against a given filter. Unused here; the outer composite handles it.'
    default: null
  sparse-checkout:
    description: 'Sparse checkout patterns. Unused here; the outer composite applies them.'
    default: null
  sparse-checkout-cone-mode:
    description: 'Whether to use cone-mode when doing a sparse checkout.'
    default: true
  fetch-depth:
    description: 'Number of commits to fetch. The local copy always carries the full local state.'
    default: 1
  fetch-tags:
    description: 'Whether to fetch tags. The local copy already carries local tags.'
    default: false
  show-progress:
    description: 'Whether to show progress status output when fetching.'
    default: true
  lfs:
    description: 'Whether to download Git-LFS files.'
    default: false
  submodules:
    description: 'Whether to checkout submodules: true, or recursive for nested submodules.'
    default: false
  set-safe-directory:
    description: 'Add repository path as safe.directory for Git global config.'
    default: true
  github-server-url:
    description: 'Base URL for the GitHub instance to clone from.'
    required: false
  checkoutref:
    description: 'The actions/checkout ref this shim replaced (set by the outer composite).'
    default: v2
outputs:
  skip:
    description: 'true when the local copy succeeded; false routes the composite to real actions/checkout.'
runs:
  using: 'node20'
  main: 'index.js'
`;

/**
 * Dependency-free port of the engine's inner index.js. Same wire protocol
 * (GET …/_apis/v1/Message/multipart/<runid> → multipart stream of "mode:path" file parts and
 * "lnk:path" symlink fields), but outputs go to the GITHUB_OUTPUT env file. Plain string constant
 * (no template-literal syntax inside) so the archive is reproducible and reviewable.
 */
export const INNER_INDEX_JS = [
  '// notdownhub inner localcheckout (#107, #111): warning-free port of the engine\'s inner action.',
  '// Streams the dispatching machine\'s working tree from the hub. No dependencies.',
  '"use strict";',
  'var fs = require("fs");',
  'var os = require("os");',
  'var path = require("path");',
  'var http = require("http");',
  'var https = require("https");',
  'var crypto = require("crypto");',
  'var env = process.env;',
  '',
  '// #111 invariant: every exit must be a deliberate outcome (success, failure, or the remote',
  '// fallback). If the event loop drains any other way — the live shape was a paused response',
  '// socket, which does NOT hold the loop — the step fails instead of passing on a partial tree.',
  'var settled = false;',
  'process.on("exit", function (code) {',
  '    if (!settled && code === 0) {',
  '        fs.writeSync(1, "::error::The repository stream never completed; refusing to report this checkout as successful" + os.EOL);',
  '        process.exitCode = 1;',
  '    }',
  '});',
  '',
  'function getInput(name) {',
  '    return (env["INPUT_" + name.replace(/ /g, "_").toUpperCase()] || "").trim();',
  '}',
  'function esc(s) {',
  '    return String(s).replace(/%/g, "%25").replace(/\\r/g, "%0D").replace(/\\n/g, "%0A");',
  '}',
  'function info(msg) { process.stdout.write(msg + os.EOL); }',
  'function debug(msg) { process.stdout.write("::debug::" + esc(msg) + os.EOL); }',
  'function warning(msg) { process.stdout.write("::warning::" + esc(msg) + os.EOL); }',
  'function setFailed(msg) { settled = true; process.exitCode = 1; process.stdout.write("::error::" + esc(msg) + os.EOL); }',
  '// The modern outputs mechanism (what the current toolkit does under the hood): append a',
  '// heredoc-style record to the GITHUB_OUTPUT env file. Never the deprecated stdout command.',
  'function setOutput(name, value) {',
  '    var file = env.GITHUB_OUTPUT;',
  '    if (!file) throw new Error("GITHUB_OUTPUT is not set; this runner cannot receive env-file outputs");',
  '    var val = typeof value === "string" ? value : JSON.stringify(value);',
  '    var delim = "ghadelimiter_" + crypto.randomUUID();',
  '    fs.appendFileSync(file, name + "<<" + delim + os.EOL + val + os.EOL + delim + os.EOL);',
  '}',
  '// .NET encodes non-ASCII part names as RFC 2047 words: =?utf-8?B?<base64>?=',
  'function decodeName(formname) {',
  '    if (formname.indexOf("=?utf-8?B?") === 0) {',
  '        var b64 = formname.substring(10);',
  '        var q = b64.indexOf("?=");',
  '        if (q !== -1) b64 = b64.substring(0, q);',
  '        return Buffer.from(b64, "base64").toString("utf-8");',
  '    }',
  '    return formname;',
  '}',
  '',
  '// Streaming multipart/form-data parser for the ONE producer that exists here:',
  '// Runner.Client\'s MultipartFormDataContent (CRLF line ends, quoted params, no preamble).',
  'function parseMultipart(stream, boundary, handlers) {',
  '    var marker = Buffer.from("\\r\\n--" + boundary);',
  '    var buf = Buffer.from("\\r\\n"); // virtual leading CRLF so the first boundary matches marker',
  '    var state = 0; // 0=seek marker, 1=after marker, 2=part headers, 3=part data',
  '    var part = null;',
  '    var sawTerminator = false;',
  '    var openWriters = 0;',
  '    var streamDone = false;',
  '    var unparsed = 0;',
  '    var writeErrors = 0;',
  '    function maybeFinish() {',
  '        if (streamDone && openWriters === 0) handlers.done(sawTerminator, unparsed, writeErrors);',
  '    }',
  '    // #111 root cause: Node never emits drain once end() was called, so a pause armed on drain',
  '    // alone strands the source forever when a big part\'s tail and boundary arrive in one chunk',
  '    // (and a paused socket lets the process exit 0). close/error always fire eventually.',
  '    function pauseUntilFlushed(ws) {',
  '        stream.pause();',
  '        var resumed = false;',
  '        function go() { if (!resumed) { resumed = true; stream.resume(); } }',
  '        ws.once("drain", go);',
  '        ws.once("close", go);',
  '        ws.once("error", go);',
  '    }',
  '    function beginPart(rawHeaders) {',
  '        var disp = /content-disposition:\\s*([^\\r\\n]*)/i.exec(rawHeaders);',
  '        // .NET quotes a parameter value only when it must ("644:x" always, "README.txt" never),',
  '        // so both forms occur in one stream. filename can also appear only as RFC 5987 filename*.',
  '        var nameMatch = disp && /(?:^|;)\\s*name\\s*=\\s*(?:"([^"]*)"|([^;]*))/i.exec(disp[1]);',
  '        var fileMatch = disp && /(?:^|;)\\s*filename\\*?\\s*=/i.exec(disp[1]);',
  '        var rawName = nameMatch ? (nameMatch[1] !== undefined ? nameMatch[1] : nameMatch[2].trim()) : null;',
  '        part = { name: rawName, isFile: Boolean(fileMatch), ws: null, chunks: [] };',
  '        if (part.name === null) {',
  '            unparsed++;',
  '            warning("Unparseable multipart disposition: `" + (disp ? disp[1] : rawHeaders.split("\\r\\n")[0]) + "`");',
  '            return;',
  '        }',
  '        var formname = decodeName(part.name);',
  '        var modeend = formname.indexOf(":");',
  '        part.mode = modeend === -1 ? "644" : formname.substring(0, modeend);',
  '        part.relpath = modeend === -1 ? formname : formname.substring(modeend + 1);',
  '        handlers.sawPath(part.relpath);',
  '        if (!part.isFile) return; // lnk fields buffer in memory, handled at part end',
  '        var target = path.join(handlers.dest, part.relpath);',
  '        if ((target + path.sep).indexOf(handlers.dest + path.sep) !== 0) {',
  '            warning("Refusing entry outside the destination: `" + part.relpath + "`");',
  '            return;',
  '        }',
  '        try {',
  '            if (part.relpath.charAt(part.relpath.length - 1) === "/") {',
  '                // Folder entry: materialize the directory itself; there is no payload to write.',
  '                fs.mkdirSync(target, { recursive: true });',
  '                handlers.sawEntry();',
  '                debug(part.relpath + ", folder => " + target);',
  '                return;',
  '            }',
  '            fs.mkdirSync(path.dirname(target), { recursive: true });',
  '            part.target = target;',
  '            part.ws = fs.createWriteStream(target);',
  '        } catch (e) {',
  '            writeErrors++;',
  '            warning("Failed to create `" + target + "`: " + e.message);',
  '            return;',
  '        }',
  '        handlers.sawEntry();',
  '        openWriters++;',
  '        part.ws.on("error", function (e) { writeErrors++; warning("Failed to write `" + target + "`: " + e.message); });',
  '        part.ws.on("close", function () { openWriters--; maybeFinish(); });',
  '        debug(part.relpath + ", mode=" + part.mode + " => " + target);',
  '    }',
  '    function writeData(data) {',
  '        if (!part || data.length === 0) return;',
  '        if (part.ws) {',
  '            if (!part.ws.write(data)) pauseUntilFlushed(part.ws);',
  '            return;',
  '        }',
  '        if (!part.isFile) part.chunks.push(Buffer.from(data));',
  '        // guarded-away file data and folder payloads are discarded',
  '    }',
  '    function endPart() {',
  '        if (!part) return;',
  '        if (part.ws) {',
  '            var p = part;',
  '            p.ws.end(function () {',
  '                try { fs.chmodSync(p.target, p.mode); }',
  '                catch (e) { warning("Failed to set mode of `" + p.target + "` to " + p.mode); }',
  '            });',
  '        } else if (!part.isFile && part.name !== null) {',
  '            handlers.sawEntry();',
  '            var value = Buffer.concat(part.chunks).toString("utf-8");',
  '            if (part.mode === "lnk") {',
  '                var lnkpath = path.join(handlers.dest, part.relpath);',
  '                if ((lnkpath + path.sep).indexOf(handlers.dest + path.sep) === 0) {',
  '                    try {',
  '                        fs.mkdirSync(path.dirname(lnkpath), { recursive: true });',
  '                        handlers.symlink(lnkpath, value);',
  '                    } catch (e) {',
  '                        warning("Failed to create directory for symlink `" + lnkpath + "` to `" + value + "`");',
  '                    }',
  '                } else {',
  '                    warning("Refusing symlink outside the destination: `" + part.relpath + "`");',
  '                }',
  '            } else {',
  '                warning("Expected mode lnk, ignore entry `" + part.relpath + "`");',
  '            }',
  '            debug(part.relpath + ", mode=" + part.mode + " => " + value);',
  '        }',
  '        part = null;',
  '    }',
  '    function pump() {',
  '        for (;;) {',
  '            if (state === 0) {',
  '                var i = buf.indexOf(marker);',
  '                if (i === -1) {',
  '                    if (buf.length > marker.length) buf = buf.subarray(buf.length - marker.length);',
  '                    return;',
  '                }',
  '                buf = buf.subarray(i + marker.length);',
  '                state = 1;',
  '            } else if (state === 1) {',
  '                if (buf.length < 2) return;',
  '                if (buf[0] === 45 && buf[1] === 45) { sawTerminator = true; stream.resume(); return; }',
  '                buf = buf.subarray(2); // CRLF after the boundary line',
  '                state = 2;',
  '            } else if (state === 2) {',
  '                var h = buf.indexOf("\\r\\n\\r\\n");',
  '                if (h === -1) return;',
  '                beginPart(buf.subarray(0, h).toString("latin1"));',
  '                buf = buf.subarray(h + 4);',
  '                state = 3;',
  '            } else {',
  '                var j = buf.indexOf(marker);',
  '                if (j === -1) {',
  '                    var safe = buf.length - marker.length;',
  '                    if (safe > 0) {',
  '                        var chunk = buf.subarray(0, safe);',
  '                        buf = buf.subarray(safe);',
  '                        writeData(chunk); // may pause the source; buf is already consumed',
  '                    }',
  '                    return;',
  '                }',
  '                writeData(buf.subarray(0, j));',
  '                buf = buf.subarray(j + marker.length);',
  '                endPart();',
  '                state = 1;',
  '            }',
  '        }',
  '    }',
  '    stream.on("data", function (d) {',
  '        if (sawTerminator) return;',
  '        buf = buf.length === 0 ? d : Buffer.concat([buf, d]);',
  '        pump();',
  '    });',
  '    stream.on("end", function () {',
  '        endPart();',
  '        streamDone = true;',
  '        maybeFinish();',
  '    });',
  '    stream.on("error", function (e) { handlers.error(e); });',
  '}',
  '',
  'try {',
  '    var checkoutref = getInput("checkoutref");',
  '    var inputPath = getInput("path");',
  '    var repository = getInput("repository");',
  '    var ref = getInput("ref");',
  '    if (!(repository !== env.GITHUB_REPOSITORY || (ref !== "" && ref !== env.GITHUB_REF && ref !== env.GITHUB_SHA))) {',
  '        repository = null;',
  '        ref = null;',
  '    } else {',
  '        if (!repository) {',
  '            if (!ref) ref = env.GITHUB_REF;',
  '            repository = env.GITHUB_REPOSITORY;',
  '        } else if (!ref) {',
  '            ref = "main";',
  '        }',
  '    }',
  '    var submodules = false;',
  '    var nestedSubmodules = false;',
  '    var submodulesString = getInput("submodules").toUpperCase();',
  '    if (submodulesString === "RECURSIVE") {',
  '        submodules = true;',
  '        nestedSubmodules = true;',
  '    } else if (submodulesString === "TRUE") {',
  '        submodules = true;',
  '    }',
  '    var url = env.ACTIONS_RUNTIME_URL + "_apis/v1/Message/multipart/" + env.GITHUB_RUN_ID +',
  '        "?submodules=" + (submodules ? "true" : "false") +',
  '        "&nestedSubmodules=" + (nestedSubmodules ? "true" : "false") +',
  '        (repository && ref ? "&repositoryAndRef=" + encodeURIComponent(repository + "@" + ref) : "");',
  '    var workspace = env.GITHUB_WORKSPACE;',
  '    if (checkoutref.toLowerCase().indexOf("v1") === 0) {',
  '        workspace = path.join(workspace, "..");',
  '        if (!inputPath) inputPath = path.basename(workspace);',
  '    }',
  '    var dest = inputPath ? path.join(workspace, inputPath) : workspace;',
  '    if ((dest + path.sep).indexOf(workspace + path.sep) !== 0) {',
  '        throw new Error("Repository path \'" + dest + "\' is not under \'" + workspace + "\'");',
  '    }',
  '    var clean = getInput("clean");',
  '    if (clean === "" || clean === "true") {',
  '        info("Clean folder: " + dest);',
  '        if (fs.existsSync(dest)) {',
  '            for (var entry of fs.readdirSync(dest)) {',
  '                fs.rmSync(path.join(dest, entry), { recursive: true, force: true });',
  '            }',
  '        }',
  '    }',
  '    info("Copying Repository to " + dest);',
  '    fs.mkdirSync(dest, { recursive: true });',
  '    (url.indexOf("https://") === 0 ? https : http).get(url, function (res) {',
  '        var skip = res.statusCode === 200;',
  '        setOutput("skip", skip);',
  '        if (!skip) { settled = true; res.resume(); return; } // deliberate: remote fallback runs',
  '        var contentType = res.headers["content-type"] || "";',
  '        var bm = /boundary="?([^";]+)"?/i.exec(contentType);',
  '        if (!bm) {',
  '            setFailed("Repository stream is not multipart (content-type: " + contentType + ")");',
  '            res.resume();',
  '            return;',
  '        }',
  '        var symlinks = [];',
  '        var entries = 0;',
  '        var gitEntries = 0;',
  '        parseMultipart(res, bm[1], {',
  '            dest: dest,',
  '            sawPath: function (relpath) {',
  '                if (relpath === ".git" || relpath.indexOf(".git/") === 0) gitEntries++;',
  '            },',
  '            sawEntry: function () { entries++; },',
  '            symlink: function (lnkpath, value) { symlinks.push({ path: lnkpath, value: value }); },',
  '            error: function (e) { setFailed("Repository stream failed: " + e.message); },',
  '            done: function (sawTerminator, unparsed, writeErrors) {',
  '                if (!sawTerminator) {',
  '                    setFailed("Repository stream ended before the closing multipart boundary");',
  '                    return;',
  '                }',
  '                // #111 invariants: a checkout may never silently succeed empty or partial.',
  '                if (unparsed > 0) {',
  '                    setFailed(unparsed + " multipart entries had unparseable dispositions; the checkout would be missing files");',
  '                    return;',
  '                }',
  '                if (writeErrors > 0) {',
  '                    setFailed(writeErrors + " entries failed to write; the checkout is incomplete");',
  '                    return;',
  '                }',
  '                if (entries === 0) {',
  '                    setFailed("The repository stream contained no files; refusing to succeed on an empty checkout");',
  '                    return;',
  '                }',
  '                debug("Creating Symlinks");',
  '                var remaining = symlinks;',
  '                for (;;) {',
  '                    var delayed = [];',
  '                    for (var lnk of remaining) {',
  '                        if (fs.existsSync(path.join(path.dirname(lnk.path), lnk.value))) {',
  '                            debug("path=`" + lnk.path + "` => `" + lnk.value + "`");',
  '                            try { fs.symlinkSync(lnk.value, lnk.path); }',
  '                            catch (e) { warning("Failed to create symlink `" + lnk.path + "` to `" + lnk.value + "`"); }',
  '                        } else {',
  '                            debug("Delay restoring symlink path=`" + lnk.path + "` => `" + lnk.value + "`");',
  '                            delayed.push(lnk);',
  '                        }',
  '                    }',
  '                    if (remaining.length === delayed.length) {',
  '                        debug("Creating dead Symlinks");',
  '                        for (var dead of delayed) {',
  '                            debug("path=`" + dead.path + "` => `" + dead.value + "`");',
  '                            try { fs.symlinkSync(dead.value, dead.path); }',
  '                            catch (e) { warning("Failed to create symlink `" + dead.path + "` to `" + dead.value + "`"); }',
  '                        }',
  '                        break;',
  '                    }',
  '                    remaining = delayed;',
  '                }',
  '                debug("Finished creating Symlinks");',
  '                // Minimum-sanity (#111): a stream that carried .git entries must produce .git.',
  '                if (gitEntries > 0 && !fs.existsSync(path.join(dest, ".git"))) {',
  '                    setFailed("The stream carried " + gitEntries + " .git entries but no .git directory was materialized");',
  '                    return;',
  '                }',
  '                info("Materialized " + entries + " entries (" + symlinks.length + " symlinks) in " + dest);',
  '                settled = true; // the ONLY silent-success path: a completed, non-empty checkout',
  '            },',
  '        });',
  '    }).on("error", function (e) {',
  '        setFailed("Failed to reach the hub repository stream: " + e.message);',
  '    });',
  '} catch (error) {',
  '    setFailed(error.message);',
  '}',
  '',
].join("\n");

function entries(): ArchiveEntry[] {
  return [
    { name: "action.yml", data: Buffer.from(INNER_ACTION_YML, "utf8") },
    { name: "index.js", data: Buffer.from(INNER_INDEX_JS, "utf8") },
  ];
}

/** Built once per format and reused; building is pure, so a success is cacheable forever. */
const archiveCache = new Map<string, Buffer>();

export function buildInnerArchive(format: "tarball" | "zipball"): Buffer {
  const cached = archiveCache.get(format);
  if (cached) return cached;
  const archive = format === "tarball" ? buildTarGz(entries()) : buildZip(entries());
  archiveCache.set(format, archive);
  return archive;
}

/** tarball / zipball when the path is the engine's static inner-action archive; null otherwise. */
export function innerArchiveFormat(pathname: string): "tarball" | "zipball" | null {
  if (/\/localcheckout\.tar\.gz$/i.test(pathname)) return "tarball";
  if (/\/localcheckout\.zip$/i.test(pathname)) return "zipball";
  return null;
}

/**
 * Serve the ndh-owned inner action for GET .../localcheckout.tar.gz|.zip. Returns false — with
 * nothing written — when interception is disabled or the archive cannot be built, so the caller
 * proxies the engine's original static file instead (pre-#107 behavior: cosmetic warning only).
 */
export function serveInnerLocalcheckout(pathname: string, res: http.ServerResponse): boolean {
  // Operator escape hatch + live-fallback seam: force the engine's own inner action.
  if (process.env.NDH_INNER_LOCALCHECKOUT === "engine") return false;
  const format = innerArchiveFormat(pathname);
  if (!format) return false;
  try {
    const archive = buildInnerArchive(format);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length });
    res.end(archive);
    return true;
  } catch {
    return false;
  }
}

export const __test = {
  resetArchiveCache: () => archiveCache.clear(),
  poisonArchiveCache: (format: "tarball" | "zipball", value: unknown) =>
    archiveCache.set(format, value as Buffer),
};
