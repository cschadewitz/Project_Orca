#!/usr/bin/env node
/**
 * The legacy fence of `orca store sqlite switch` (#339), checked against real released builds.
 *
 * v0.7.0 and v0.6.0 open a store without reading its format marker, so a store switched to
 * SQLite keeps them out with markers (packages/store/src/sqlite/legacy-fence.ts). This runs the
 * released CLIs themselves, first against an unswitched workspace made the same way (the baseline),
 * then against the switched store, and fails unless every covered command:
 *
 * - reaches the store in the baseline: it exists in that release, its arguments are accepted, it
 *   neither times out nor dies on a signal, and (for `serve`) the daemon comes up and answers;
 * - is refused by the store on the switched store: a nonzero exit whose output carries one of
 *   that release's store-refusal signatures, which its baseline output does not;
 * - and leaves every byte of the switched store as it was.
 *
 * A daemon that starts on the switched store (v0.6.0 opens nothing while it starts) must refuse
 * every store-facing request it is sent. Read-only listings a release may answer from files both
 * backends keep are reported apart, as answered, never as refused; they too must change nothing.
 *
 *   node tools/legacy-fence/run.js --current packages/cli/dist/main.js \
 *     --legacy v0.7.0=<checkout>/packages/cli/dist/main.js --legacy v0.6.0=<...> \
 *     [--scratch dir] [--output report.json]
 *
 * The workspace is made by the first released build's own `demo` (scripted agents, no model),
 * opened once by the current build, and switched with the current CLI; each baseline is another
 * such workspace. CI: legacy-fence.yml.
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
 * How a released build fails on a switched store, by what the fence put in its way: v0.7.0
 * refuses on the marker in place of its execution key before anything else; v0.6.0 trips over a
 * marker where it expects a directory (`runs`, `workflows`), an array (the collection files) or a
 * file (the artifact index). Anything else is not counted as a refusal.
 */
const REFUSAL =
  /protected execution record or key is missing, invalid or unreadable|EEXIST: file already exists, mkdir|ENOTDIR|EISDIR|is not iterable|orcaStore/;
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

function cli(main, cwd, args, timeoutMs = 120_000, env = {}) {
  const result = spawnSync(process.execPath, [main, ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
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

async function rpc(port, method, params) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, error: { code: "TRANSPORT", message: String(error) } };
  }
}

/**
 * `serve`: refused at start, or up (its `/health` answers) and then sent every probe, then
 * stopped. `up` is false when it neither exited nor answered within the time allowed.
 */
async function serve(main, cwd, runId) {
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
  if (exit) return { ...exit, output, up: false, answers: [] };
  const answers = [];
  if (up)
    for (const probe of probes(runId)) {
      const reply = await rpc(port, probe.method, probe.params);
      answers.push({ method: probe.method, ok: reply.ok === true, error: reply.ok ? null : (reply.error ?? null) });
    }
  child.kill("SIGTERM");
  const stopped = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 10_000))]);
  if (!stopped) child.kill("SIGKILL");
  await exited;
  return { code: exit.code, signal: exit.signal, output, up, answers, ranUntilStopped: true };
}

/** A protocol-level failure: the method or its params were not accepted, so nothing was tested. */
const protocolError = (error) => /^PROTOCOL_|^TRANSPORT$/.test(error?.code ?? "");

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

// 1. The workspace to switch, and a baseline workspace for each release.
const target = workspaceAt(join(scratch, "workspace"));
const workspace = target.dir;
const store = join(workspace, ".orca");
const baselines = new Map(legacy.map(({ tag }) => [tag, workspaceAt(join(scratch, `baseline-${tag}`))]));

// 2. The switch, with the current CLI.
// The in-place switch is not offered to users yet; this check opts into it (Linux only).
const switched = cli(current, workspace, ["store", "sqlite", "switch"], 120_000, {
  ORCA_IN_PLACE_SQLITE_SWITCH: "unenforced",
});
report.switch = switched.output.trim();
if (switched.code !== 0) throw new Error(`switch failed:\n${switched.output}`);

// 3. Every released build, every command that opens the store: baseline first, then switched.
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
    // The switched store.
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
      else if (result.code === 0) fail(`${where} succeeded on a switched store`);
      else if (!refusal) fail(`${where} failed without a store refusal: ${firstLine(result.output)}`);
    }
    console.log(`${where}: ${row.outcome}, exit ${result.code ?? result.signal} ${refusal ?? ""}`);
  }
}

function firstLine(output) {
  return (output.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 160);
}

// 5. The current build still has everything, on SQLite.
const after = cli(current, workspace, ["runs"]);
if (after.code !== 0) fail(`the current build cannot open the switched store:\n${after.output}`);
else if (JSON.stringify(runLines(after.output)) !== JSON.stringify(target.runs))
  fail("the current build lists different runs after the switch");
const format = cli(current, workspace, ["store", "format"]);
if (!format.output.includes("SQLite (metadata.sqlite)")) fail("store format does not report SQLite");

if (values.output) writeFileSync(resolve(values.output), JSON.stringify(report, null, 2) + "\n");
if (!report.failures.length) {
  const counts = report.legacy.map((l) => {
    const by = (o) => l.commands.filter((c) => c.outcome === o).length;
    return `${l.tag}: ${by("refused")} refused, ${by("started, every store request refused")} daemon refusing every request, ${by("answered (read-only)")} answered read-only, ${l.absent.length} not in the release`;
  });
  console.log(`ok, and nothing changed the store. ${counts.join("; ")}`);
  rmSync(scratch, { recursive: true, force: true });
} else process.exitCode = 1;
