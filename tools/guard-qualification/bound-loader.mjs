// Loaded-code binding for one reviewed module graph. Preparation only; not a
// runtime component and not imported by any package.
//
// usage: node --permission --allow-fs-read=<root> --disallow-code-generation-from-strings \
//          <root>/bound-loader.mjs <manifest path> <manifest sha256> <entry relative path>
//
// Before any candidate module is evaluated this loader reads every module the
// reviewed manifest lists, verifies exact size and SHA-256 through non-following
// descriptors, and keeps those bytes in memory. Synchronous module hooks then
// serve only those in-memory bytes for import, dynamic import, require and
// createRequire; anything unlisted, any non-allowlisted builtin and any native
// addon refuses. Later changes to files on disk cannot change what is served.
// Hook registration is then locked and WebAssembly is removed.
//
// Trust assumptions: the Node/V8 binary and its builtins, this loader file (its
// bytes are bound by the supervisor before launch), and same-process integrity
// (candidate code shares this realm; process.binding and other internals remain
// reachable, so the boundary is cooperative against hostile code and must be
// combined with containment and the Node permission model).
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import Module, { isBuiltin, registerHooks, syncBuiltinESMExports } from "node:module";
import { isAbsolute, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_MODULES = 32;
const MAX_MODULE_BYTES = 256 * 1024 * 1024;
const FORMATS = new Set(["module", "commonjs", "json"]);
const DENIED_BUILTINS = new Set([
  "node:child_process",
  "node:cluster",
  "node:dgram",
  "node:dns",
  "node:http",
  "node:http2",
  "node:https",
  "node:inspector",
  "node:inspector/promises",
  "node:net",
  "node:repl",
  "node:tls",
  "node:trace_events",
  "node:v8",
  "node:vm",
  "node:wasi",
  "node:worker_threads",
]);

function refuse(code) {
  process.stderr.write(`orca-bound-loader refused ${code}\n`);
  process.exit(96);
}

function readExact(path, bytes) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    refuse("loader_symlink");
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (bytes !== undefined && info.size !== bytes) || info.size > MAX_MODULE_BYTES) {
      refuse("loader_digest_mismatch");
    }
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > info.size) refuse("loader_digest_mismatch");
    }
    if (total !== info.size) refuse("loader_digest_mismatch");
    return buffer.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const [manifestPath, manifestSha256, entryPath] = process.argv.slice(2);
if (process.argv.length !== 5 || !/^[0-9a-f]{64}$/.test(manifestSha256 ?? "")) refuse("loader_manifest_invalid");
const manifestBytes = readExact(manifestPath);
if (sha256(manifestBytes) !== manifestSha256) refuse("loader_digest_mismatch");
let manifest;
try {
  manifest = JSON.parse(manifestBytes.toString("utf8"));
} catch {
  refuse("loader_manifest_invalid");
}
const keys = (o) =>
  Object.keys(o ?? {})
    .sort()
    .join(",");
if (
  keys(manifest) !== "builtins,modules,root,version" ||
  manifest.version !== 1 ||
  typeof manifest.root !== "string" ||
  !isAbsolute(manifest.root) ||
  normalize(manifest.root) !== manifest.root ||
  !Array.isArray(manifest.modules) ||
  manifest.modules.length === 0 ||
  manifest.modules.length > MAX_MODULES ||
  !Array.isArray(manifest.builtins) ||
  !manifest.builtins.every((b) => typeof b === "string" && b.startsWith("node:") && !DENIED_BUILTINS.has(b))
) {
  refuse("loader_manifest_invalid");
}

const served = new Map();
for (const entry of manifest.modules) {
  if (
    keys(entry) !== "bytes,format,path,sha256" ||
    typeof entry.path !== "string" ||
    !Number.isSafeInteger(entry.bytes) ||
    !/^[0-9a-f]{64}$/.test(entry.sha256)
  ) {
    refuse("loader_manifest_invalid");
  }
  if (!FORMATS.has(entry.format)) refuse("loader_format_unknown");
  const parts = entry.path.split("/");
  if (isAbsolute(entry.path) || parts.some((p) => p === "" || p === "." || p === "..")) {
    refuse("loader_manifest_invalid");
  }
  // Every intermediate component must be a real directory, never a symlink.
  let cursor = manifest.root;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor + sep + part;
    let fd;
    try {
      fd = openSync(cursor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    } catch {
      refuse("loader_symlink");
    }
    closeSync(fd);
  }
  const absolute = manifest.root + sep + entry.path;
  const source = readExact(absolute, entry.bytes);
  if (sha256(source) !== entry.sha256) refuse("loader_digest_mismatch");
  const url = pathToFileURL(absolute).href;
  if (served.has(url)) refuse("loader_manifest_invalid");
  served.set(url, { source, format: entry.format });
}
const allowedBuiltins = new Set(manifest.builtins);
const entryUrl = pathToFileURL(manifest.root + sep + entryPath).href;
if (!served.has(entryUrl)) refuse("loader_module_unlisted");

const loaded = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier)) {
      const name = specifier.startsWith("node:") ? specifier : `node:${specifier}`;
      if (!allowedBuiltins.has(name)) refuse("loader_builtin_denied");
      return { url: name, shortCircuit: true };
    }
    const result = nextResolve(specifier, context);
    if (!served.has(result.url)) refuse("loader_module_unlisted");
    return { url: result.url, format: served.get(result.url).format, shortCircuit: true };
  },
  load(url, context, nextLoad) {
    if (url.startsWith("node:")) {
      if (!allowedBuiltins.has(url)) refuse("loader_builtin_denied");
      return nextLoad(url, context);
    }
    const module = served.get(url);
    if (module === undefined) refuse("loader_module_unlisted");
    loaded.push(url);
    return { format: module.format, source: module.source, shortCircuit: true };
  },
});

const locked = () => refuse("loader_builtin_denied");
for (const name of ["register", "registerHooks"]) {
  Object.defineProperty(Module, name, { value: locked, writable: false, configurable: false });
}
syncBuiltinESMExports();
delete globalThis.WebAssembly;
process.on("exit", () => {
  process.stderr.write(`orca-bound-loader loaded ${JSON.stringify(loaded.map((u) => sha256(served.get(u).source)))}\n`);
});
await import(entryUrl);
