#!/usr/bin/env node
// Start the ORCA demo daemon and the desktop app in dev mode, in one foreground command.
//
//   node .claude/skills/orca-demo-dev/scripts/start.mjs [--dir <path>] [--fresh] [--seed] [--daemon-only]
//
// 1. Makes a demo workspace once (`orca demo --dir`): scripted agents, a finished program
//    run, a plan with risks and decisions. Reused on later starts; --fresh rebuilds it.
// 2. Copies the repo's workflows into the workspace and points the config at the copies.
//    The workflow editor only edits files inside the configuration directory, and the demo
//    config names the repo's own workflows/, so without this there is no Edit button.
// 3. Rebuilds @orca/design's dist. The renderer reads the package through dist, and a dist
//    older than semantics.json is a sidebar with the wrong surfaces in it.
// 4. Starts `orca serve` on the workspace and waits for it to say it is listening.
// 5. With --seed, submits more work through the daemon so every surface is populated
//    (seed.mjs): a running run, gates waiting for an answer, a failure, a cancellation and a
//    second request's plan. The seed agents are added to the config before the daemon starts.
// 6. Starts `pnpm --filter @orca/app dev` against it (Vite on :5273 plus Electron).
//
// Ctrl-C, or closing the app window, stops both. If the daemon dies, the app is stopped
// too, so a session never outlives half of itself.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { prepareSeedConfig, seed } from "./seed.mjs";
import { defaultWorkspace, repoRoot, say } from "./workspace.mjs";

const isWindows = process.platform === "win32";
const READY_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const options = { dir: undefined, fresh: false, seed: false, daemonOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fresh") options.fresh = true;
    else if (arg === "--seed") options.seed = true;
    else if (arg === "--daemon-only") options.daemonOnly = true;
    else if (arg === "--dir") options.dir = argv[++i];
    else if (arg.startsWith("--dir=")) options.dir = arg.slice("--dir=".length);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: start.mjs [--dir <path>] [--fresh] [--seed] [--daemon-only]\n");
      process.exit(0);
    } else {
      console.error(`[orca-demo] unknown option: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const dir = resolve(options.dir ?? defaultWorkspace());
const configFile = join(dir, "orca.config.yaml");
const tokenFile = join(dir, "auth", "local-client.token");

const log = (message) => say(`[orca-demo] ${message}`);

/** Quote one argument for cmd.exe, which is what `shell: true` runs on Windows. */
const quote = (arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg);

/**
 * Spawn pnpm. Windows needs a shell to find `pnpm.cmd`, and Node 24 deprecates passing an
 * argument array alongside `shell: true`, so there the command goes as one quoted string.
 * Elsewhere the child leads its own process group, which is what lets `stop` reach the
 * grandchildren (tsx, Electron) as well.
 */
function spawnPnpm(args, extra = {}) {
  const base = { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], ...extra };
  return isWindows
    ? spawn(["pnpm", ...args].map(quote).join(" "), { ...base, shell: true })
    : spawn("pnpm", args, { ...base, detached: true });
}

/** Run pnpm to completion with its output shown, failing the script if it fails. */
function runPnpm(args) {
  const result = isWindows
    ? spawnSync(["pnpm", ...args].map(quote).join(" "), { cwd: repoRoot, stdio: "inherit", shell: true })
    : spawnSync("pnpm", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[orca-demo] pnpm ${args.join(" ")} exited with ${result.status ?? result.signal}`);
    process.exit(1);
  }
}

/** Prefix every line a child writes, so two interleaved logs stay readable. */
function pipeLines(child, label, onLine) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on("line", (line) => {
      say(`[${label}] ${line}`);
      onLine?.(line);
    });
  }
}

/** Stop a child and everything it started. */
function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (isWindows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// ---------- 1. the workspace ----------

if (options.fresh && existsSync(dir)) {
  // Only ever delete something this script made: a demo workspace has its playbook.
  const entries = readdirSync(dir);
  if (entries.length > 0 && !existsSync(join(dir, "demo-playbook.yaml"))) {
    console.error(`[orca-demo] refusing --fresh: ${dir} is not empty and is not a demo workspace`);
    process.exit(2);
  }
  log(`removing ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}

if (!existsSync(configFile)) {
  log(`creating the demo workspace in ${dir} (runs the program workflow once with scripted agents)`);
  runPnpm(["run", "demo", "--dir", dir, "--quiet"]);
} else {
  log(`reusing the demo workspace in ${dir} (pass --fresh to rebuild it)`);
}

// ---------- 2. editable workflows ----------

const LOCAL_WORKFLOWS = "workflows/*.yaml";
const config = readFileSync(configFile, "utf8");
const eol = config.includes("\r\n") ? "\r\n" : "\n";
const workflowsBlock = /^workflows:\r?\n(?:[ \t]+- .*\r?\n)+/m;
const block = config.match(workflowsBlock)?.[0];
if (block === undefined) {
  console.error(`[orca-demo] no workflows list in ${configFile}; cannot make the workflows editable`);
  process.exit(1);
}
if (!block.includes(`- ${LOCAL_WORKFLOWS}`)) {
  const target = join(dir, "workflows");
  mkdirSync(target, { recursive: true });
  const files = readdirSync(join(repoRoot, "workflows")).filter((name) => name.endsWith(".yaml"));
  for (const name of files) copyFileSync(join(repoRoot, "workflows", name), join(target, name));
  writeFileSync(configFile, config.replace(workflowsBlock, `workflows:${eol}  - ${LOCAL_WORKFLOWS}${eol}`));
  log(`copied ${files.length} workflows into ${target} so the editor can change them`);
}

if (options.seed && prepareSeedConfig(dir)) log("added the seed agents, and gates now wait for an answer");

// ---------- 3. a current @orca/design ----------

log("building @orca/design");
runPnpm(["exec", "tsc", "--build", "packages/design"]);

// ---------- 4. the daemon ----------

log("starting the daemon");
const daemon = spawnPnpm(["run", "orca", "--config", configFile, "serve"]);
let app;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stop(app);
  stop(daemon);
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => shutdown(0));

const daemonUrl = await new Promise((resolveReady, rejectReady) => {
  const timer = setTimeout(
    () => rejectReady(new Error(`the daemon did not report it was listening within ${READY_TIMEOUT_MS / 1000}s`)),
    READY_TIMEOUT_MS,
  );
  pipeLines(daemon, "daemon", (line) => {
    const match = /listening on (\S+)/.exec(line);
    if (match) {
      clearTimeout(timer);
      resolveReady(match[1]);
    }
  });
  daemon.once("exit", (code) => {
    clearTimeout(timer);
    rejectReady(new Error(`the daemon exited with ${code} before it was listening (is port 6722 already in use?)`));
  });
}).catch((error) => {
  console.error(`[orca-demo] ${error.message}`);
  shutdown(1);
});

daemon.on("exit", (code) => {
  if (shuttingDown) return;
  console.error(`[orca-demo] the daemon exited with ${code}; stopping the app`);
  shutdown(code ?? 1);
});

log(`daemon listening on ${daemonUrl}`);

if (options.seed) {
  log("seeding: submitting work through the daemon");
  await seed({ dir, url: daemonUrl }).catch((error) => {
    console.error(`[orca-demo] seeding failed: ${error.message}`);
    shutdown(1);
  });
}

if (options.daemonOnly) {
  log(`daemon only. Point the app at it with ORCA_WORKSPACE=${dir} ORCA_DAEMON_TOKEN_FILE=${tokenFile}`);
  log("press Ctrl-C to stop");
} else {
  // ---------- 6. the app ----------

  log("starting the app (Vite renderer + Electron)");
  app = spawnPnpm(["--filter", "@orca/app", "dev"], {
    env: { ...process.env, ORCA_WORKSPACE: dir, ORCA_DAEMON_TOKEN_FILE: tokenFile },
  });
  pipeLines(app, "app", (line) => {
    if (line.includes("renderer dev server on")) log("renderer is up; the Electron window opens next");
  });
  // Closing the window ends the session, the way `pnpm --filter @orca/app dev` does alone.
  app.on("exit", (code) => {
    if (shuttingDown) return;
    log(`the app exited with ${code}; stopping the daemon`);
    shutdown(code ?? 0);
  });
  log("press Ctrl-C, or close the app window, to stop both");
}
