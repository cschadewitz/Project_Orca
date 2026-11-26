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
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => process.stdout.write(`${line}\n`);

function fail(message) {
  console.error(`server-bundle-smoke: ${message}`);
  process.exit(1);
}

const dir = resolve(process.argv[2] ?? fail("usage: server-bundle-smoke.mjs DIR"));
const inside = JSON.parse(readFileSync(join(dir, "orca-server.json"), "utf8"));
const contract = JSON.parse(readFileSync(join(dir, "release-compatibility.json"), "utf8"));
const node = join(dir, inside.node);
const entry = join(dir, inside.entry);
// Nothing from the runner's ORCA environment reaches the bundle.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ORCA_")));

function orca(args, options = {}) {
  const result = spawnSync(node, [entry, ...args], { encoding: "utf8", env, timeout: 120_000, ...options });
  if (result.status !== 0)
    fail(`${args.join(" ")} exited ${result.status ?? result.signal}:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

const version = orca(["--version"]);
if (version !== inside.version) fail(`the CLI says ${version}, the bundle is ${inside.version}`);
say(`version ${version} from ${inside.node}`);

const scratch = mkdtempSync(join(tmpdir(), "orca-bundle-smoke-"));
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

  const port = await new Promise((ok) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
  const workspace = join(scratch, "serve");
  mkdirSync(workspace);
  const child = spawn(node, [entry, "--cwd", workspace, "serve", "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let exited = false;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-8192)));
  child.on("exit", () => (exited = true));
  try {
    let last;
    for (let i = 0; i < 120; i++) {
      if (exited) fail(`the daemon exited before it said hello:\n${stderr}`);
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
        });
        const reply = await response.json();
        if (!reply.ok) throw new Error(JSON.stringify(reply.error));
        const hello = reply.result;
        if (hello.processId !== child.pid) fail(`hello is from process ${hello.processId}, not ${child.pid}`);
        const protocol = JSON.stringify(hello.protocol);
        if (hello.orcaVersion !== inside.version || protocol !== JSON.stringify(contract.protocol))
          fail(`hello says ${hello.orcaVersion} protocol ${protocol}`);
        const missing = contract.capabilities.filter((name) => !(hello.capabilities ?? []).includes(name));
        if (missing.length) fail(`the daemon is missing ${missing.join(", ")}`);
        if (!(hello.methods ?? []).includes("maintenance")) fail("the daemon has no admission barrier");
        say(`hello from ${inside.version} (protocol ${hello.protocol.major}.${hello.protocol.minor}) on port ${port}`);
        last = undefined;
        break;
      } catch (error) {
        last = error;
        await sleep(500);
      }
    }
    if (last) fail(`no hello: ${last.message ?? last}`);
  } finally {
    child.kill();
    for (let i = 0; i < 40 && !exited; i++) await sleep(250);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
say("the bundle runs");
