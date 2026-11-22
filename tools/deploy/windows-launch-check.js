#!/usr/bin/env node
/**
 * Start an installed Windows ORCA as a person would and wait until its window reports a live
 * connection to the bundled daemon, then end it (Release (accept Windows arm64), #889).
 *
 *   node tools/deploy/windows-launch-check.js EXECUTABLE
 *
 * The app runs with a throwaway profile and workspace and is driven over the renderer's
 * DevTools protocol with Node's own WebSocket, so the check needs no dependency installed:
 * the same `window.orca.connection.read().state === "live"` that the Windows update test waits
 * for (packages/app/test/windows-update/update.spec.ts). That proves the installed main
 * process, renderer, preload and bundled daemon (with its native addons) start on this
 * machine's architecture. Exits 0 when live, 1 otherwise.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 9351;
const STARTUP_MS = 90_000;
const LIVE_MS = 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Evaluate `expression` in the page behind `url` (a DevTools WebSocket), by value. */
export async function evaluate(url, expression, WebSocketImpl = globalThis.WebSocket) {
  const socket = new WebSocketImpl(url);
  try {
    await new Promise((ok, fail) => {
      socket.addEventListener("open", ok, { once: true });
      socket.addEventListener("error", () => fail(new Error("DevTools socket error")), { once: true });
    });
    const reply = new Promise((ok, fail) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails) fail(new Error(JSON.stringify(message)));
        else ok(message.result?.result?.value);
      });
      socket.addEventListener("close", () => fail(new Error("DevTools socket closed")), { once: true });
    });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    return await reply;
  } finally {
    socket.close();
  }
}

/** Poll until `probe` resolves to a truthy value, or throw `message` after `ms`. */
export async function until(probe, ms, message, interval = 1_000) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`${message}${last ? ` (last error: ${last.message})` : ""}`);
    await sleep(interval);
  }
}

async function main(executable) {
  const root = mkdtempSync(join(tmpdir(), "orca-launch-check-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const env = { ...process.env, ORCA_WORKSPACE: workspace };
  for (const name of ["ELECTRON_RUN_AS_NODE", "ORCA_UPDATE_URL", "ORCA_UPDATE_TOKEN_FILE", "ORCA_UPDATE_PRERELEASE"])
    delete env[name];
  const child = spawn(executable, [`--user-data-dir=${join(root, "profile")}`, `--remote-debugging-port=${PORT}`], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[app] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stdout.write(`[app] ${chunk}`));
  let exited = false;
  child.once("exit", (code) => {
    exited = true;
    console.log(`[app] exited ${code}`);
  });
  try {
    const page = await until(
      async () => {
        if (exited) throw new Error("the app exited during startup");
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        return targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      },
      STARTUP_MS,
      "the app's window did not open a DevTools page",
    );
    console.log(`window: ${page.url}`);
    const state = await until(
      async () => {
        if (exited) throw new Error("the app exited before its connection was live");
        const value = await evaluate(page.webSocketDebuggerUrl, "window.orca?.connection.read().state ?? null");
        console.log(`connection: ${value}`);
        return value === "live" ? value : undefined;
      },
      LIVE_MS,
      "the app's connection to its bundled daemon never became live",
      2_000,
    );
    console.log(`the installed app started and its connection is ${state}`);
    return 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  } finally {
    if (!exited && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "inherit" });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  if (!executable) {
    console.error("usage: windows-launch-check.js EXECUTABLE");
    process.exit(2);
  }
  process.exit(await main(executable));
}
