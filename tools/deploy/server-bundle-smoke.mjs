#!/usr/bin/env node
/**
 * Run an unpacked server bundle the way a host's setup checks it before using it (#1238): its
 * own runtime runs the CLI's `--version`, the scripted demo against the bundle's shipped
 * workflows, `validate` of a configuration that reads them, and a temporary daemon whose hello
 * must carry the bundle's version, protocol, capabilities and admission barrier.
 *
 *   node tools/deploy/server-bundle-smoke.mjs DIR
 *
 * DIR is the bundle's top-level directory (orca-server-X.Y.Z-PLATFORM/). Only the bundle's own
 * runtime (`node` in its orca-server.json) runs ORCA; the Node running this script only drives
 * it. The same checks as orca-release.py's validate_stage on Linux, for a platform that has no
 * Python setup adapter yet. Exits 0 when every check passes, 1 otherwise.
 *
 * Every failure is thrown, never exited on, so the temporary daemon is always stopped and the
 * scratch directory always removed before the exit code is set. Waiting for the hello has one
 * deadline, and each request within it its own timeout, so a daemon that accepts a connection
 * and never answers cannot hold the check open. A daemon that cannot be started fails the check
 * as such, and one whose stop is not confirmed within a bounded wait after SIGKILL is reported
 * as that, never waited on forever.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether `promise` settles within `ms`; the timer never outlives the answer. */
async function within(promise, ms) {
  let timer;
  const late = new Promise((ok) => (timer = setTimeout(() => ok(false), ms)));
  try {
    return await Promise.race([promise.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A check the bundle failed: not retried. */
class Refused extends Error {}

function freePort() {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

/**
 * Run the checks on the bundle in `dir`. Resolves when they pass, rejects with what failed.
 * `tmp` is where the scratch directory goes; `helloMs` and `requestMs` bound the hello, `stopMs`
 * and `killMs` the waits for the daemon to stop after SIGTERM and after SIGKILL. `start` spawns
 * the daemon (a stand-in in tests).
 */
export async function smokeBundle(
  dir,
  {
    tmp = tmpdir(),
    helloMs = 60_000,
    requestMs = 5_000,
    stopMs = 10_000,
    killMs = 5_000,
    start = spawn,
    say = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  const inside = JSON.parse(readFileSync(join(dir, "orca-server.json"), "utf8"));
  const contract = JSON.parse(readFileSync(join(dir, "release-compatibility.json"), "utf8"));
  const node = join(dir, inside.node);
  const entry = join(dir, inside.entry);
  // Nothing from the runner's ORCA environment reaches the bundle.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ORCA_")));

  const orca = (args, options = {}) => {
    const result = spawnSync(node, [entry, ...args], { encoding: "utf8", env, timeout: 120_000, ...options });
    if (result.status !== 0)
      throw new Refused(
        `${args.join(" ")} exited ${result.status ?? result.signal}:\n${result.stdout}\n${result.stderr}`,
      );
    return result.stdout.trim();
  };

  const version = orca(["--version"]);
  if (version !== inside.version) throw new Refused(`the CLI says ${version}, the bundle is ${inside.version}`);
  say(`version ${version} from ${inside.node}`);

  const scratch = mkdtempSync(join(tmp, "orca-bundle-smoke-"));
  try {
    orca(["demo", "--dir", join(scratch, "demo")], { env: { ...env, ORCA_RELEASE: dir } });
    say("demo passed");

    // Each check in its own directory: the daemon below must not find this configuration upwards.
    mkdirSync(join(scratch, "validate"));
    const config = join(scratch, "validate", "orca.config.yaml");
    writeFileSync(
      config,
      [
        "version: 1",
        "storeDir: .orca",
        "hosts:",
        "  - id: local",
        "    type: local",
        "agents: []",
        "workflows: ['${ORCA_RELEASE}/workflows/**/*.yaml']",
        "templates: ['${ORCA_RELEASE}/templates/**/*.md']",
        "",
      ].join("\n"),
    );
    orca(["--config", config, "validate"], { cwd: join(scratch, "validate"), env: { ...env, ORCA_RELEASE: dir } });
    say("validate passed");

    const port = await freePort();
    const workspace = join(scratch, "serve");
    mkdirSync(workspace);
    const child = start(node, [entry, "--cwd", workspace, "serve", "--port", String(port)], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr = (stderr + chunk).slice(-8192)));
    // Ended: it exited, or it never started (a failed spawn emits `error`, not `exit`).
    let gone = false;
    let failedStart;
    const ended = new Promise((ok) => {
      child.once("exit", () => ok());
      child.once("error", (error) => {
        failedStart ??= error;
        ok();
      });
    }).then(() => (gone = true));
    let failure;
    try {
      const hello = await waitForHello({
        port,
        workspace,
        contract,
        helloMs,
        requestMs,
        gone: () => gone,
        why: () =>
          failedStart
            ? `the daemon could not start: ${failedStart.message}`
            : `the daemon exited before it said hello:\n${stderr}`,
      });
      if (hello.processId !== child.pid)
        throw new Refused(`hello is from process ${hello.processId}, not ${child.pid}`);
      const protocol = JSON.stringify(hello.protocol);
      if (hello.orcaVersion !== inside.version || protocol !== JSON.stringify(contract.protocol))
        throw new Refused(`hello says ${hello.orcaVersion} protocol ${protocol}`);
      const missing = contract.capabilities.filter((name) => !(hello.capabilities ?? []).includes(name));
      if (missing.length) throw new Refused(`the daemon is missing ${missing.join(", ")}`);
      if (!(hello.methods ?? []).includes("maintenance")) throw new Refused("the daemon has no admission barrier");
      say(`hello from ${inside.version} (protocol ${hello.protocol.major}.${hello.protocol.minor}) on port ${port}`);
    } catch (error) {
      failure = error;
    }
    // Stop it, each wait bounded: SIGTERM, then SIGKILL, then report a stop never confirmed.
    if (!gone) {
      child.kill();
      if (!(await within(ended, stopMs))) {
        child.kill("SIGKILL");
        if (!(await within(ended, killMs))) {
          const unstopped = `the daemon (process ${child.pid}) did not confirm it stopped after SIGKILL`;
          failure = new Refused(failure ? `${failure.message}; and ${unstopped}` : unstopped);
        }
      }
    }
    if (failure) throw failure;
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  say("the bundle runs");
}

/** The daemon's hello, asked until it answers or the deadline passes. */
async function waitForHello({ port, workspace, contract, helloMs, requestMs, gone, why }) {
  const deadline = Date.now() + helloMs;
  let last;
  while (Date.now() < deadline) {
    if (gone()) throw new Refused(why());
    try {
      const token = readFileSync(join(workspace, "auth", "local-client.token"), "utf8").trim();
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          kind: "request",
          id: 1,
          method: "hello",
          params: { client: "orca-release", protocol: contract.protocol },
        }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestMs, deadline - Date.now()))),
      });
      const reply = await response.json();
      if (!reply.ok) throw new Error(JSON.stringify(reply.error));
      return reply.result;
    } catch (error) {
      last = error;
      await sleep(Math.max(0, Math.min(500, deadline - Date.now())));
    }
  }
  throw new Refused(`no hello within ${helloMs} ms: ${last?.message ?? last}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: server-bundle-smoke.mjs DIR");
    process.exitCode = 1;
  } else {
    try {
      await smokeBundle(resolve(dir));
    } catch (error) {
      console.error(`server-bundle-smoke: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  }
}
