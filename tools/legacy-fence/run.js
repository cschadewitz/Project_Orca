#!/usr/bin/env node
/**
 * The legacy fence of `orca store sqlite convert` (#339), checked against real released builds.
 *
 * v0.7.0 and v0.6.0 open a store without reading its format marker. Converting a workspace's
 * file store makes a SQLite store of its own beside it (`<store>-sqlite`), fenced against them
 * with markers (packages/store/src/sqlite/legacy-fence.ts) before anything has opened it, and
 * names it in the workspace's config; the file store is left exactly as it was. This runs the
 * released builds themselves and fails unless:
 *
 * - the conversion, made with the shipped CLI while a released daemon of each version is already
 *   running on the workspace, changes no byte of the file store;
 * - every covered command, started after the conversion, reaches the store in a baseline (an
 *   unconverted workspace made the same way: it exists in that release, takes its arguments,
 *   neither times out nor dies on a signal, and `serve` comes up and answers), and on the
 *   converted workspace is refused by the store (a nonzero exit carrying one of that release's
 *   store-refusal signatures, which its baseline output does not), changing no byte of the new
 *   store. A daemon that starts there anyway (v0.6.0 opens nothing while it starts) must refuse
 *   every store request it is sent. Read-only answers are reported apart, never as refusals;
 * - the daemons that were already running keep serving the old store and change nothing in the
 *   new one, and a write a released ORCA makes to the old store afterwards is reported by
 *   `orca store format` on the new one;
 * - the shipped in-place `orca store sqlite switch` still refuses and changes nothing.
 *
 *   node tools/legacy-fence/run.js --current packages/cli/dist/main.js \
 *     --legacy v0.7.0=<checkout>/packages/cli/dist/main.js --legacy v0.6.0=<...> \
 *     [--scratch dir] [--output report.json]
 *
 * Workspaces are made by the first released build's own `demo` (scripted agents, no model) and
 * opened once by the current build. CI: legacy-fence.yml.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

/**
 * How a released build fails on a converted store, by what the fence put in its way: v0.7.0
 * refuses on the marker in place of its execution key before anything else; v0.6.0 trips over a
 * marker where it expects a directory (`runs`, `workflows`), an array (the collection files) or a
 * file (the artifact index). Anything else is not counted as a refusal.
 */
const REFUSAL =
  /protected execution record or key is missing, invalid or unreadable|EEXIST: file already exists, mkdir|ENOTDIR|EISDIR|is not iterable|orcaStore/; // rename-keep: released builds print orcaStore
/** A command the release does not have, or arguments it does not take: not a baseline. */
const UNUSABLE = /unknown command|unknown flag|CONFIG_INVALID|EADDRINUSE/i;

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
  return {
    code: result.status,
    signal: result.signal ?? null,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });

/** What a daemon is asked once it is up: every method that reads or writes the store. */
const probes = (runId) => [
  { method: "runs.list", params: {} },
  { method: "runs.get", params: { runId } },
  { method: "runs.events", params: { runId } },
  { method: "plans.list", params: {} },
  { method: "inputs.list", params: {} },
  { method: "claims.list", params: {} },
  { method: "workflows.list", params: {} },
  { method: "runs.start", params: { workflowId: "ai-sdlc", vars: { workItem: { slug: "x", title: "X" } } } },
];

/** v0.7.0's daemon authenticates: its local credential, written beside the workspace's config. */
function bearer(cwd) {
  try {
    return { authorization: `Bearer ${readFileSync(join(cwd, "auth", "local-client.token"), "utf8").trim()}` };
  } catch {
    return {};
  }
}

async function rpc(port, method, params, cwd) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(cwd) },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, error: { code: "TRANSPORT", message: String(error) } };
  }
}

/**
 * Start `serve` and wait until it answers `/health` or exits. `stop()` ends it and returns how.
 */
async function startDaemon(main, cwd) {
  const port = await freePort();
  const child = spawn(process.execPath, [main, "serve", "--port", String(port)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  let exit;
  const exited = new Promise((r) =>
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      r(exit);
    }),
  );
  let up = false;
  for (let i = 0; i < 60 && !exit && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).then(
      (r) => r.ok,
      () => false,
    );
  }
  const stop = async () => {
    if (!exit) {
      child.kill("SIGTERM");
      const stopped = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 10_000))]);
      if (!stopped) child.kill("SIGKILL");
      await exited;
    }
    return { code: exit.code, signal: exit.signal, output };
  };
  return { port, up, exited: () => exit, output: () => output, stop };
}

/** Every probe, sent to a daemon that is up. */
async function probeAll(port, runId, cwd) {
  const answers = [];
  for (const probe of probes(runId)) {
    const reply = await rpc(port, probe.method, probe.params, cwd);
    answers.push({ method: probe.method, ok: reply.ok === true, error: reply.ok ? null : (reply.error ?? null) });
  }
  return answers;
}

/**
 * `serve`: refused at start, or up (its `/health` answers) and then sent every probe, then
 * stopped. `up` is false when it neither exited nor answered within the time allowed.
 */
async function serve(main, cwd, runId) {
  const daemon = await startDaemon(main, cwd);
  const early = daemon.exited();
  if (early) return { ...early, output: daemon.output(), up: false, answers: [] };
  const answers = daemon.up ? await probeAll(daemon.port, runId, cwd) : [];
  const end = await daemon.stop();
  return { ...end, up: daemon.up, answers, ranUntilStopped: true };
}

/** A protocol-level failure: the method or its params were not accepted, so nothing was tested. */
const protocolError = (error) => /^PROTOCOL_|^AUTH_|^TRANSPORT$/.test(error?.code ?? "");

const report = { scratch, current, legacy: [], failures: [] };
const fail = (message) => {
  report.failures.push(message);
  console.error(`FAIL ${message}`);
};

/** The run lines of `orca runs`, in a stable order (backends may list them differently). */
const runLines = (output) =>
  output
    .split("\n")
    .filter((l) => l.startsWith("run_"))
    .sort();

/**
 * A realistic workspace from the first released build's own `demo`, opened once by the current
 * build, and the ids the commands below name in it. Records are bound to their store's path, so
 * each baseline is a workspace of its own rather than a copy.
 */
function workspaceAt(dir) {
  const demo = cli(legacy[0].cli, scratch, ["demo", "--dir", dir, "--keep"], 600_000);
  if (demo.code !== 0) {
    console.error(demo.output);
    throw new Error(`${legacy[0].tag} demo failed`);
  }
  const opened = cli(current, dir, ["runs"]);
  if (opened.code !== 0) throw new Error(`the current build could not open the demo store:\n${opened.output}`);
  const runs = runLines(opened.output);
  if (!runs.length) throw new Error("the demo store has no runs");
  const workItems = readFileSync(join(dir, ".orca", "work-items.json"), "utf8");
  return {
    dir,
    runs,
    runId: runs[0].split(/\s+/)[0],
    workItemId: /wi_[A-Za-z0-9_-]+/.exec(workItems)?.[0] ?? "wi_x",
  };
}

// 1. The workspace to convert, and a baseline workspace for each release.
const target = workspaceAt(join(scratch, "workspace"));
const workspace = target.dir;
const source = join(workspace, ".orca");
const baselines = new Map(legacy.map(({ tag }) => [tag, workspaceAt(join(scratch, `baseline-${tag}`))]));
// The workspace's config as it was, naming the file store: what a released ORCA that was already
// running had read.
const oldConfig = join(scratch, "old.config.yaml");
writeFileSync(oldConfig, readFileSync(join(workspace, "orca.config.yaml"), "utf8"));

// 2. A released daemon of each version already running on the workspace; then the conversion,
// with the shipped CLI. It must leave the file store exactly as it was.
const running = [];
for (const { tag, cli: main } of legacy) {
  const daemon = await startDaemon(main, workspace);
  if (!daemon.up)
    fail(`${tag} serve did not come up on the workspace before the conversion: ${firstLine(daemon.output())}`);
  running.push({ tag, daemon });
}
const sourceBefore = snapshot(source);
const converted = cli(current, workspace, ["store", "sqlite", "convert"]);
report.convert = converted.output.trim();
if (converted.code !== 0) throw new Error(`convert failed:\n${converted.output}`);
const store = join(workspace, ".orca-sqlite");
const sourceChanges = diff(sourceBefore, snapshot(source));
if (sourceChanges.length) fail(`the conversion changed the file store: ${sourceChanges.slice(0, 5).join(", ")}`);
if (!readFileSync(join(workspace, "orca.config.yaml"), "utf8").includes(".orca-sqlite"))
  fail("the workspace's config does not name the converted store");

// 3. Every released build, every command that opens the store, started after the conversion:
// baseline first, then the converted workspace.
const commands = ({ runId, workItemId }) => [
  ["runs"],
  ["status", runId],
  ["events", runId],
  ["plan", "list"],
  ["plan", "show", "demo"],
  ["plan", "journal", "demo"],
  ["plan", "dispatch", "demo"],
  ["claims", "list"],
  ["claims", "release", workItemId, "--force"],
  ["leases", "list"],
  ["leases", "break", runId, "--force"],
  ["admissions", "list"],
  ["answer"],
  ["resume", runId],
  ["submit", "Fenced?", "--body", "a legacy write"],
  ["run", "ai-sdlc", "--var", 'workItem={"slug":"x","title":"X"}', "--quiet"],
  ["serve"],
];
// Read-only listings a released build may answer from files both backends keep (leases): reported
// as answered when they succeed, and never allowed to change anything.
const mayAnswer = new Set(["leases list"]);
// `workflows.list` answers from the workflows a daemon registered in memory at start, not the store.
const mayAnswerRpc = new Set(["workflows.list"]);

for (const { tag, cli: main } of legacy) {
  const entry = { tag, commands: [], absent: [] };
  report.legacy.push(entry);
  const baseline = baselines.get(tag);
  const baseCommands = commands(baseline);
  for (const [i, args] of commands(target).entries()) {
    // The command as named in each workspace (its run and work item ids), reported generically.
    const name = args.join(" ").replace(target.runId, "<run>").replace(target.workItemId, "<work item>");
    const isServe = args[0] === "serve";
    const base = isServe ? await serve(main, baseline.dir, baseline.runId) : cli(main, baseline.dir, baseCommands[i]);
    if (!isServe && /unknown command/i.test(base.output)) {
      entry.absent.push(name);
      console.log(`${tag} ${name}: not in this release`);
      continue;
    }
    const before = snapshot(store);
    const result = isServe ? await serve(main, workspace, target.runId) : cli(main, workspace, args);
    const changes = diff(before, snapshot(store));
    const refusal = REFUSAL.exec(result.output)?.[0] ?? null;
    const row = {
      command: name,
      baseline: { code: base.code, signal: base.signal ?? null, refusal: REFUSAL.exec(base.output)?.[0] ?? null },
      code: result.code,
      signal: result.signal ?? null,
      refusal,
      outcome: "refused",
      changes,
      ...(isServe ? { up: result.up, answers: result.answers, baselineAnswers: base.answers } : {}),
    };
    entry.commands.push(row);
    const where = `${tag} ${name}`;
    // The baseline: the command reached the store.
    if (base.signal && !base.ranUntilStopped) fail(`${where}: baseline died on ${base.signal} (timeout?)`);
    if (UNUSABLE.test(base.output)) fail(`${where}: baseline did not accept the command: ${firstLine(base.output)}`);
    if (row.baseline.refusal) fail(`${where}: baseline already fails like a refusal (${row.baseline.refusal})`);
    if (isServe) {
      if (!base.up) fail(`${where}: baseline daemon did not come up: ${firstLine(base.output)}`);
      for (const answer of base.answers ?? [])
        if (protocolError(answer.error)) fail(`${where}: baseline ${answer.method} not accepted: ${answer.error.code}`);
    }
    // The converted store.
    if (changes.length) fail(`${where} changed the store: ${changes.slice(0, 5).join(", ")}`);
    if (isServe && result.ranUntilStopped) {
      if (!result.up) fail(`${where}: daemon neither refused to start nor came up`);
      row.outcome = "started, every store request refused";
      for (const answer of result.answers) {
        if (protocolError(answer.error)) fail(`${where}: ${answer.method} not accepted: ${answer.error.code}`);
        else if (answer.ok && !mayAnswerRpc.has(answer.method)) fail(`${where}: ${answer.method} succeeded`);
        else if (!answer.ok && !REFUSAL.test(answer.error?.message ?? ""))
          fail(`${where}: ${answer.method} failed without a store refusal: ${answer.error?.message ?? "?"}`);
      }
    } else if (result.code === 0 && mayAnswer.has(name)) row.outcome = "answered (read-only)";
    else {
      if (result.signal) fail(`${where}: died on ${result.signal} (timeout?)`);
      else if (result.code === 0) fail(`${where} succeeded on a converted store`);
      else if (!refusal) fail(`${where} failed without a store refusal: ${firstLine(result.output)}`);
    }
    console.log(`${where}: ${row.outcome}, exit ${result.code ?? result.signal} ${refusal ?? ""}`);
  }
}

function firstLine(output) {
  return (output.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 160);
}

// 4. The daemons that were already running: they keep serving the file store, and change nothing
// in the new one; a released ORCA's write to the file store afterwards is reported.
report.running = [];
for (const { tag, daemon } of running) {
  const before = snapshot(store);
  const reads = [];
  for (const method of ["runs.list", "plans.list"]) {
    const reply = await rpc(daemon.port, method, {}, workspace);
    reads.push({ method, ok: reply.ok === true, error: reply.ok ? null : (reply.error ?? null) });
  }
  const end = await daemon.stop();
  const changes = diff(before, snapshot(store));
  report.running.push({ tag, reads, exit: end.code ?? end.signal, changes });
  for (const read of reads)
    if (!read.ok)
      fail(`${tag} daemon that was already running could not ${read.method} the file store: ${read.error?.message}`);
  if (changes.length)
    fail(`${tag} daemon that was already running changed the new store: ${changes.slice(0, 5).join(", ")}`);
  console.log(
    `${tag} serve, already running: ${reads.map((r) => `${r.method} ${r.ok ? "answered" : "failed"}`).join(", ")}, new store unchanged`,
  );
}
const late = cli(legacy[0].cli, workspace, [
  "--config",
  oldConfig,
  "submit",
  "Late",
  "--body",
  "written to the file store",
]);
if (late.code !== 0)
  fail(`${legacy[0].tag} could not write to the file store after the conversion: ${firstLine(late.output)}`);
const drift = cli(current, workspace, ["store", "format"]);
report.drift = drift.output.split("\n").find((l) => l.startsWith("converted from")) ?? "";
if (!/CHANGED since/.test(report.drift))
  fail(`store format did not report the write to the file store: ${report.drift}`);

// 5. The shipped in-place switch still refuses, even with the opt-in an earlier draft had, and changes nothing.
const fresh = workspaceAt(join(scratch, "refused"));
const freshBefore = snapshot(join(fresh.dir, ".orca"));
const refused = spawnSync(process.execPath, [current, "store", "sqlite", "switch"], {
  cwd: fresh.dir,
  encoding: "utf8",
  env: { ...process.env, ORCA_IN_PLACE_SQLITE_SWITCH: "unenforced" },
});
if (refused.status === 0 || !/SWITCH_REFUSED|not available/.test(`${refused.stdout}${refused.stderr}`))
  fail(`the shipped \`orca store sqlite switch\` did not refuse: ${refused.stdout}${refused.stderr}`);
if (diff(freshBefore, snapshot(join(fresh.dir, ".orca"))).length) fail("the refused shipped switch changed the store");

// 6. The current build still has everything, on SQLite.
const after = cli(current, workspace, ["runs"]);
if (after.code !== 0) fail(`the current build cannot open the converted store:\n${after.output}`);
else if (JSON.stringify(runLines(after.output)) !== JSON.stringify(target.runs))
  fail("the current build lists different runs after the conversion");
const format = cli(current, workspace, ["store", "format"]);
if (!format.output.includes("SQLite (metadata.sqlite)")) fail("store format does not report SQLite");

if (values.output) writeFileSync(resolve(values.output), JSON.stringify(report, null, 2) + "\n");
if (!report.failures.length) {
  const counts = report.legacy.map((l) => {
    const by = (o) => l.commands.filter((c) => c.outcome === o).length;
    return `${l.tag}: ${by("refused")} refused, ${by("started, every store request refused")} daemon refusing every request, ${by("answered (read-only)")} answered read-only, ${l.absent.length} not in the release`;
  });
  console.log(
    `ok: the conversion left the file store as it was, and nothing changed the new store. ${counts.join("; ")}`,
  );
  rmSync(scratch, { recursive: true, force: true });
} else process.exitCode = 1;
