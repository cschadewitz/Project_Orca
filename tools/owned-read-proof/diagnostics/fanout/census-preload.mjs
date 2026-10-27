/** DIAGNOSTIC ONLY (#706 fan-out investigation). Loaded with `node --import` into the
 * controlled child, it counts synchronous fs calls by phase and records real JavaScript
 * stacks at each child currentness check (its single /proc/self/fdinfo/<lifetime> open).
 * Not an observer, not syscall evidence, never part of an image or authority.
 *
 * ORCA_CENSUS_OUT   output JSON path (required)
 * ORCA_CENSUS_LIGHT "1": capture stacks only at unit entries (fast enough to finish)
 * ORCA_CENSUS_SEQ   "1": also write an ordered event log with promise-continuation ids
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { executionAsyncId, createHook } from "node:async_hooks";

const light = process.env.ORCA_CENSUS_LIGHT === "1";
const sequence = process.env.ORCA_CENSUS_SEQ === "1";
// Without an enabled hook Node does not track promise continuations, so
// executionAsyncId() would stay constant across awaits.
if (sequence) createHook({ init() {} }).enable();

const READS = ["lstatSync", "statSync", "fstatSync", "realpathSync", "readFileSync", "openSync"];
const OTHERS = [
  "readSync",
  "writeSync",
  "closeSync",
  "existsSync",
  "readdirSync",
  "writeFileSync",
  "fsyncSync",
  "renameSync",
  "unlinkSync",
  "mkdirSync",
  "linkSync",
  "rmSync",
  "ftruncateSync",
];
const NON_EFFECTS = new Set([...READS, "readSync", "closeSync"]);
const original = Object.fromEntries([...READS, ...OTHERS].map((name) => [name, fs[name]]));
const [, child, base, , lifetimeArg, commandArg, ackArg] = process.argv;
const lifetimeFd = Number(lifetimeArg),
  commandFd = Number(commandArg),
  ackFd = Number(ackArg);
const image = dirname(child);
const out = process.env.ORCA_CENSUS_OUT;

// Map bundle line numbers back to source modules through esbuild's `// path` markers.
const marks = [];
original.readFileSync
  .call(fs, join(image, "controlled-producer.mjs"), "utf8")
  .split("\n")
  .forEach((line, index) => {
    const match = /^\/\/ ((?:packages|node_modules)\/\S+)$/.exec(line);
    if (match) marks.push([index + 1, match[1]]);
  });
const moduleOf = (line) => {
  let low = 0,
    high = marks.length - 1,
    result = "?";
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (marks[middle][0] <= line) {
      result = marks[middle][1];
      low = middle + 1;
    } else high = middle - 1;
  }
  return result.replace(/^packages\//, "").replace(/\/src\//, "/");
};

let phase = "init";
const counts = new Map(); // phase|op|class -> calls
const checkStacks = new Map(); // phase|stack at each child check -> calls
const bindingStacks = new Map(); // phase|stack at realpath(control) (baseline gate only)
const proofStacks = new Map(); // phase|stack at receipt reads
const statxByOwner = new Map(); // phase|owner -> metadata/open calls (heavy mode)
const events = [];
const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const ancestors = new Set();
for (let cursor = base; ; cursor = dirname(cursor)) {
  ancestors.add(cursor);
  if (dirname(cursor) === cursor) break;
}
const ROOTS = ["workspace", "workspace/.orca", "workspace/.orca/workspace-identity", "control", "releases"];
const classify = (path) => {
  if (typeof path === "number")
    return path === lifetimeFd
      ? "fd:lifetime"
      : path === commandFd
        ? "fd:command"
        : path === ackFd
          ? "fd:ack"
          : "fd:other";
  if (typeof path !== "string") return "?";
  if (path.startsWith("/proc/self/fdinfo/")) return "fdinfo";
  if (path.startsWith(image + "/")) return "image-file";
  if (ancestors.has(path)) return "base-or-ancestor";
  if (path.endsWith("/workspace-identity/id")) return "workspace-identity-id";
  if (path.endsWith("bootstrap-association.json")) return "receipt";
  if (path.endsWith("controlled-plan.json")) return "plan";
  if (path.endsWith("lifetime.lock")) return "lifetime-path";
  if (path.endsWith("orca.permissions.json")) return "sidecar";
  if (path.endsWith("credentials.json")) return "credentials";
  if (path.includes("/leases/")) return "lease";
  if (path.includes("/control/")) return "control-file";
  if (path.startsWith(base + "/")) {
    const relative = path.slice(base.length + 1);
    if (ROOTS.includes(relative)) return "root-dir";
    return "base:" + relative.split("/").slice(0, 3).join("/");
  }
  return "other";
};
const frames = () => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  const holder = {};
  Error.captureStackTrace(holder, frames);
  Error.stackTraceLimit = limit;
  return holder.stack
    .split("\n")
    .slice(2)
    .map((text) => {
      const match = /at (?:async )?(?:(\S+) )?\(?(.*?):(\d+):\d+\)?$/.exec(text.trim());
      if (!match) return text.trim();
      const [, name = "<anon>", file, line] = match;
      if (file.endsWith("controlled-producer.mjs")) return `${name}@${moduleOf(Number(line))}:${line}`;
      if (file.endsWith("controlled-child.mjs")) return `${name}@child:${line}`;
      if (file.includes("census-preload")) return null;
      return `${name}@${file.replace(/^node:/, "")}`;
    })
    .filter(Boolean);
};
// The bound child check appears as `Object.check@child`, the direct one as `check@child`.
const owner = (stack) => {
  for (const frame of stack) {
    if (/^(Object\.)?check@child/.test(frame)) return "child.check";
    if (frame.startsWith("resolveManagedRootBinding@") || frame.startsWith("resolveBinding@"))
      return "managed.rootBinding";
  }
  for (const frame of stack) {
    if (frame.startsWith("assertCurrent@cli/typed-workspace-gate")) return "managed.identityTail";
    if (frame.includes("@child:")) return "child.other";
  }
  return "other:" + (stack.find((frame) => !frame.includes("node:")) ?? "?");
};
const components = (path) => (typeof path === "string" ? path.split("/").filter(Boolean).length : 0);
const wrap = (name, metadata) => {
  const call = original[name];
  fs[name] = function (...args) {
    const path = args[0];
    const kind = classify(path);
    bump(counts, `${phase}|${name}|${kind}`);
    const checkEntry = name === "openSync" && kind === "fdinfo";
    const entry =
      checkEntry ||
      (name === "realpathSync" && typeof path === "string" && path.endsWith("/control")) ||
      (name === "readFileSync" && kind === "receipt");
    if (metadata && (!light || entry)) {
      const stack = frames();
      bump(statxByOwner, `${phase}|${owner(stack)}`, name === "realpathSync" ? components(path) : 1);
      const key = `${phase}|${stack.slice(0, 40).join(" < ")}`;
      if (checkEntry) bump(checkStacks, key);
      if (name === "realpathSync" && entry) bump(bindingStacks, key);
      if (name === "readFileSync" && kind === "receipt") bump(proofStacks, key);
    }
    if (sequence) {
      if (checkEntry) {
        const stack = frames();
        const index = stack.findIndex((frame) =>
          /^(Object\.)?check@cli\/test\/controlled-owned-read-producer/.test(frame),
        );
        const caller = index >= 0 ? (stack[index + 1] ?? "?") : "direct:" + (stack[1] ?? "?");
        // ["C", asyncId, phase, caller, producer-check entry?, frames above producer check]
        events.push([
          "C",
          executionAsyncId(),
          phase,
          caller.replace(/:\d+$/, ""),
          stack[1]?.startsWith("Object.check@child") ? 1 : 0,
          index >= 0 ? stack.slice(index + 1, index + 7) : [],
        ]);
      } else if (!NON_EFFECTS.has(name)) events.push(["W", executionAsyncId(), phase, name]);
      else events.push(["R", executionAsyncId(), phase, name, kind]);
    }
    const result = call.apply(this, args);
    if (name === "readSync" && path === commandFd) {
      const match = /^orca-phase:([a-z-]+):/.exec(Buffer.from(args[1].buffer, args[1].byteOffset, result).toString());
      if (match) phase = match[1];
    }
    if (name === "writeSync" && path === ackFd) phase += ":after-ack";
    return result;
  };
};
for (const name of READS) wrap(name, true);
for (const name of OTHERS) wrap(name, false);
syncBuiltinESMExports();
process.on("exit", () => {
  const sorted = (map) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]));
  if (sequence) original.writeFileSync.call(fs, out + ".seq.json", JSON.stringify(events));
  original.writeFileSync.call(
    fs,
    out,
    JSON.stringify({
      counts: sorted(counts),
      statxByOwner: sorted(statxByOwner),
      checkStacks: sorted(checkStacks),
      bindingStacks: sorted(bindingStacks),
      proofStacks: sorted(proofStacks),
    }),
  );
});
