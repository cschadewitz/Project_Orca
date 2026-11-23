#!/usr/bin/env node
/**
 * The legacy fence of `orca store sqlite switch` (#339), checked against real released builds.
 *
 * v0.7.0 and v0.6.0 open a store without reading its format marker, so a store switched to
 * SQLite keeps them out with markers (packages/store/src/sqlite/legacy-fence.ts). This runs the
 * released CLIs themselves against a switched store and fails unless every command that opens
 * the store is refused and leaves every byte of it as it was.
 *
 *   node tools/legacy-fence/run.js --current packages/cli/dist/main.js \
 *     --legacy v0.7.0=<checkout>/packages/cli/dist/main.js --legacy v0.6.0=<...> \
 *     [--scratch dir] [--output report.json]
 *
 * The workspace is made by the first released build's own `demo` (scripted agents, no model),
 * opened once by the current build, and switched with the current CLI. Then each released CLI
 * runs every command that touches the store, reads and writes alike. CI: legacy-fence.yml.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    current: { type: "string" },
    legacy: { type: "string", multiple: true },
    scratch: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.current || !values.legacy?.length) {
  console.error(
    "usage: run.js --current <main.js> --legacy <tag>=<main.js> [--legacy ...] [--scratch dir] [--output file]",
  );
  process.exit(2);
}
const current = resolve(values.current);
const legacy = values.legacy.map((pair) => {
  const at = pair.indexOf("=");
  return { tag: pair.slice(0, at), cli: resolve(pair.slice(at + 1)) };
});
const scratch = mkdtempSync(join(values.scratch ? resolve(values.scratch) : tmpdir(), "orca-legacy-fence-"));

/** Every file under `dir` with its bytes' hash, and every directory, by path. Lock files are left out. */
function snapshot(dir) {
  const out = {};
  const walk = (path, prefix) => {
    for (const name of readdirSync(path).sort()) {
      if (name.endsWith(".lock")) continue;
      const full = join(path, name);
      const info = lstatSync(full);
      const key = `${prefix}${name}`;
      if (info.isDirectory()) {
        out[key] = "dir";
        walk(full, `${key}/`);
      } else out[key] = info.isSymbolicLink() ? "link" : createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

function diff(before, after) {
  const changes = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (before[key] !== after[key])
      changes.push(`${key}: ${before[key] === undefined ? "added" : after[key] === undefined ? "removed" : "changed"}`);
  return changes.sort();
}

function cli(main, cwd, args, timeoutMs = 120_000) {
  const result = spawnSync(process.execPath, [main, ...args], { cwd, encoding: "utf8", timeout: timeoutMs });
  return { code: result.status, signal: result.signal, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** `serve`: refused at start, or (if it starts) given a few seconds, then stopped. */
async function serve(main, cwd, port) {
  const child = spawn(process.execPath, [main, "serve", "--port", String(port)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 5000))]);
  if (result) return { ...result, output };
  child.kill("SIGTERM");
  return { ...(await exited), output, ranUntilStopped: true };
}

const report = { scratch, current, legacy: [], failures: [] };
const fail = (message) => {
  report.failures.push(message);
  console.error(`FAIL ${message}`);
};

// 1. A realistic workspace from the first released build, opened once by the current one.
const workspace = join(scratch, "workspace");
const demo = cli(legacy[0].cli, scratch, ["demo", "--dir", workspace, "--keep"], 600_000);
if (demo.code !== 0) {
  console.error(demo.output);
  throw new Error(`${legacy[0].tag} demo failed`);
}
const store = join(workspace, ".orca");
const opened = cli(current, workspace, ["runs"]);
if (opened.code !== 0) throw new Error(`the current build could not open the demo store:\n${opened.output}`);
/** The run lines of `orca runs`, in a stable order (backends may list them differently). */
const runLines = (output) =>
  output
    .split("\n")
    .filter((l) => l.startsWith("run_"))
    .sort();
const runsBefore = runLines(opened.output);
if (!runsBefore.length) throw new Error("the demo store has no runs");

// 2. The switch, with the current CLI.
const switched = cli(current, workspace, ["store", "sqlite", "switch"]);
report.switch = switched.output.trim();
if (switched.code !== 0) throw new Error(`switch failed:\n${switched.output}`);

// 3. Every released build, every command that opens the store.
const commands = [
  ["runs"],
  ["status", "run_x"],
  ["events", "run_x"],
  ["plan", "list"],
  ["plan", "show", "demo"],
  ["plan", "journal", "demo"],
  ["plan", "dispatch", "demo"],
  ["claims", "list"],
  ["claims", "release", "wi_x", "--force"],
  ["leases", "list"],
  ["leases", "break", "run_x", "--force"],
  ["admissions", "list"],
  ["answer"],
  ["resume", "run_x"],
  ["submit", "Fenced?", "--body", "a legacy write"],
  ["run", "ai-sdlc", "--var", 'workItem={"slug":"x","title":"X"}', "--quiet"],
];
// Read-only listings a released build may answer from files both backends keep (leases): allowed
// to succeed, never to change anything.
const mayAnswer = new Set(["leases list"]);
let port = 46_700;
for (const { tag, cli: main } of legacy) {
  const entry = { tag, commands: [] };
  report.legacy.push(entry);
  for (const args of [...commands, ["serve"]]) {
    const name = args.join(" ");
    const before = snapshot(store);
    const result = args[0] === "serve" ? await serve(main, workspace, port++) : cli(main, workspace, args);
    const changes = diff(before, snapshot(store));
    const first = result.output.split("\n").find((l) => /error|refus/i.test(l)) ?? "";
    entry.commands.push({
      command: name,
      code: result.code,
      signal: result.signal ?? null,
      error: first.trim(),
      changes,
    });
    console.log(`${tag} ${name}: exit ${result.code ?? result.signal} ${first.trim().slice(0, 120)}`);
    if (changes.length) fail(`${tag} ${name} changed the store: ${changes.slice(0, 5).join(", ")}`);
    // v0.6.0's daemon opens nothing while it starts, so it may come up; every request that
    // reaches the store fails on the markers, and it must not have changed anything.
    if (result.code === 0 && !mayAnswer.has(name) && !result.ranUntilStopped)
      fail(`${tag} ${name} succeeded on a switched store`);
  }
}

// 4. The current build still has everything, on SQLite.
const after = cli(current, workspace, ["runs"]);
if (after.code !== 0) fail(`the current build cannot open the switched store:\n${after.output}`);
else if (JSON.stringify(runLines(after.output)) !== JSON.stringify(runsBefore))
  fail("the current build lists different runs after the switch");
const format = cli(current, workspace, ["store", "format"]);
if (!format.output.includes("SQLite (metadata.sqlite)")) fail("store format does not report SQLite");

if (values.output) writeFileSync(resolve(values.output), JSON.stringify(report, null, 2) + "\n");
if (!report.failures.length) {
  console.log(`ok: ${legacy.map((l) => l.tag).join(", ")} refused every store command, and changed nothing`);
  rmSync(scratch, { recursive: true, force: true });
} else process.exitCode = 1;
