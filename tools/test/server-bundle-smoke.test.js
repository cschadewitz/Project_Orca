/**
 * tools/deploy/server-bundle-smoke.mjs (#1238): a bundle whose daemon says the wrong hello, or
 * never answers, fails the check, and either way the temporary daemon is stopped and the
 * scratch directory removed. The bundle here is a stand-in: this Node as its runtime and a
 * small entry that answers the CLI calls and serves a scripted hello.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { smokeBundle } from "../deploy/server-bundle-smoke.mjs";

const contract = JSON.parse(readFileSync(new URL("../../release-compatibility.json", import.meta.url), "utf8"));

const ENTRY = `
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9"); process.exit(0); }
if (!args.includes("serve")) process.exit(0);
const cwd = args[args.indexOf("--cwd") + 1];
const port = Number(args[args.indexOf("--port") + 1]);
writeFileSync(process.env.SMOKE_PIDFILE, String(process.pid));
mkdirSync(join(cwd, "auth"), { recursive: true });
writeFileSync(join(cwd, "auth", "local-client.token"), "token");
const contract = ${JSON.stringify(contract)};
createServer((request, response) => {
  if (process.env.SMOKE_MODE === "hang") return;
  const version = process.env.SMOKE_MODE === "wrong" ? "0.0.1" : "9.9.9";
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, result: { processId: process.pid, orcaVersion: version,
    protocol: contract.protocol, capabilities: contract.capabilities, methods: ["hello", "maintenance"] } }));
}).listen(port, "127.0.0.1");
`;

let root;
let bundle;
let scratch;
let pidfile;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smoke-test-"));
  bundle = join(root, "orca-server-9.9.9-linux-x64");
  mkdirSync(join(bundle, "runtime", "bin"), { recursive: true });
  symlinkSync(process.execPath, join(bundle, "runtime", "bin", "node"));
  writeFileSync(join(bundle, "orca-daemon.mjs"), ENTRY);
  writeFileSync(
    join(bundle, "orca-server.json"),
    JSON.stringify({ version: "9.9.9", node: "runtime/bin/node", entry: "orca-daemon.mjs" }),
  );
  writeFileSync(join(bundle, "release-compatibility.json"), JSON.stringify(contract));
  scratch = join(root, "scratch");
  mkdirSync(scratch);
  pidfile = join(root, "daemon.pid");
  process.env.SMOKE_PIDFILE = pidfile;
});

afterEach(() => {
  delete process.env.SMOKE_PIDFILE;
  delete process.env.SMOKE_MODE;
  rmSync(root, { recursive: true, force: true });
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function expectCleanedUp() {
  const pid = Number(readFileSync(pidfile, "utf8"));
  expect(alive(pid)).toBe(false);
  expect(readdirSync(scratch)).toEqual([]);
}

const quiet = { say: () => {} };

it.skipIf(process.platform === "win32")("passes a bundle whose daemon says the right hello", async () => {
  await smokeBundle(bundle, { ...quiet, tmp: scratch });
  expectCleanedUp();
});

it.skipIf(process.platform === "win32")(
  "fails a wrong hello and still stops the daemon and removes its directory",
  async () => {
    process.env.SMOKE_MODE = "wrong";
    await expect(smokeBundle(bundle, { ...quiet, tmp: scratch })).rejects.toThrow("hello says 0.0.1");
    expectCleanedUp();
  },
);

it.skipIf(process.platform === "win32")(
  "fails a daemon that never answers by its deadline, and cleans up",
  async () => {
    process.env.SMOKE_MODE = "hang";
    const started = Date.now();
    await expect(smokeBundle(bundle, { ...quiet, tmp: scratch, helloMs: 3_000, requestMs: 1_000 })).rejects.toThrow(
      "no hello within 3000 ms",
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    expectCleanedUp();
    expect(existsSync(pidfile)).toBe(true);
  },
);

it.skipIf(process.platform === "win32")("fails a daemon that cannot be started, and cleans up", async () => {
  const start = () => {
    const child = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => child.emit("error", new Error("spawn EACCES")));
    return child;
  };
  await expect(smokeBundle(bundle, { ...quiet, tmp: scratch, start })).rejects.toThrow(
    "the daemon could not start: spawn EACCES",
  );
  expect(readdirSync(scratch)).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "reports a daemon that never confirms it stopped instead of waiting on it, and cleans up",
  async () => {
    const signals = [];
    const start = () => {
      const child = new EventEmitter();
      child.pid = 424242;
      child.kill = (signal) => signals.push(signal);
      return child;
    };
    const started = Date.now();
    await expect(
      smokeBundle(bundle, { ...quiet, tmp: scratch, start, helloMs: 500, requestMs: 200, stopMs: 200, killMs: 200 }),
    ).rejects.toThrow(
      /no hello within 500 ms.*; and the daemon \(process 424242\) did not confirm it stopped after SIGKILL/s,
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readdirSync(scratch)).toEqual([]);
  },
);

it.skipIf(process.platform === "win32")(
  "escalates past a signal that could not be delivered to a live daemon, and lets go of it",
  async () => {
    const signals = [];
    let unref = false;
    let destroyed = false;
    const start = () => {
      const child = new EventEmitter();
      child.pid = 434343;
      child.stderr = Object.assign(new EventEmitter(), { destroy: () => (destroyed = true) });
      child.unref = () => (unref = true);
      child.kill = (signal) => {
        signals.push(signal);
        // What Node does when the signal cannot be delivered: `error` on a child that has a pid.
        setImmediate(() => child.emit("error", new Error(`kill EPERM (${signal})`)));
        return false;
      };
      return child;
    };
    await expect(
      smokeBundle(bundle, { ...quiet, tmp: scratch, start, helloMs: 500, requestMs: 200, stopMs: 200, killMs: 200 }),
    ).rejects.toThrow(
      /no hello within 500 ms.*; and the daemon \(process 434343\) did not confirm it stopped after SIGKILL \(kill EPERM \(SIGTERM\); kill EPERM \(SIGKILL\)\)/s,
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(destroyed).toBe(true);
    expect(unref).toBe(true);
    expect(readdirSync(scratch)).toEqual([]);
  },
);
