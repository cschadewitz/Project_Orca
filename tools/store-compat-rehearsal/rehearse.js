#!/usr/bin/env node
/**
 * Disposable cross-version store rehearsal: prior release -> candidate -> offline restore.
 *
 *   node tools/store-compat-rehearsal/rehearse.js --old <checkout> --new <checkout> --work <new dir>
 *        [--entry source|dist] [--old-node <node>] [--new-node <node>]
 *
 * Both checkouts need their own dependencies installed (`pnpm install --frozen-lockfile`;
 * `pnpm run build` too for `--entry dist`). Everything is written under --work, which must
 * not exist; nothing is deleted, including on failure, and no operator workspace, service,
 * credential or network is used. The store comes from the prior release's own scripted
 * `demo`, so it is that release's source output on this machine - synthetic, never
 * installed evidence. The prior binary only ever writes its own fresh store and, after the
 * restore, that same restored store; the candidate's records are judged by the prior
 * release's schemas in-process (schema-read.js) instead of by running the prior binary on
 * them. See docs/preparation/store-compatibility-rehearsal/README.md.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { rehearse } from "./rehearsal.js";

const here = dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
  options: {
    old: { type: "string" },
    new: { type: "string" },
    work: { type: "string" },
    entry: { type: "string", default: "source" },
    "old-node": { type: "string", default: process.execPath },
    "new-node": { type: "string", default: process.execPath },
  },
});
if (!options.old || !options.new || !options.work || !["source", "dist"].includes(options.entry)) {
  console.error("usage: rehearse.js --old <checkout> --new <checkout> --work <new dir> [--entry source|dist]");
  process.exit(2);
}
const work = resolve(options.work);
const sides = {
  old: { checkout: resolve(options.old), node: options["old-node"] },
  new: { checkout: resolve(options.new), node: options["new-node"] },
};
// Operator settings must not leak into a disposable rehearsal (daemon URLs, workspaces,
// update fences, admission files, tokens).
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ORCA_")));

function describe(side) {
  const { checkout, node } = sides[side];
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  const json = (file) => JSON.parse(readFileSync(join(checkout, file), "utf8"));
  const manifest = json("release-compatibility.json");
  const pkg = json("package.json");
  return {
    checkout,
    commit: git("rev-parse", "HEAD"),
    modified: git("status", "--porcelain", "--untracked-files=no") !== "",
    version: pkg.version,
    nodeEngine: pkg.engines?.node,
    node: execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
    storeEpoch: manifest.storeEpoch,
    protocol: manifest.protocol,
    capabilities: manifest.capabilities,
  };
}

function command(side, args) {
  const { checkout, node } = sides[side];
  return options.entry === "dist"
    ? { file: node, args: [join(checkout, "packages/cli/dist/main.js"), ...args], cwd: checkout }
    : { file: node, args: ["--import", "tsx", join(checkout, "packages/cli/src/main.ts"), ...args], cwd: checkout };
}

/** Run one CLI command to completion, or until `until` matches its output and then SIGTERM. */
function run(side, args, { until, timeoutMs = 600_000 } = {}) {
  const { file, args: argv, cwd } = command(side, args);
  return new Promise((done) => {
    const child = spawn(file, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let matched = false;
    let timedOut = false;
    let error;
    child.once("error", (failure) => {
      error = failure.message;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const watch = (chunk) => {
      output += chunk;
      if (until && !matched && until.test(output)) {
        matched = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ side, args, code, signal, matched, timedOut, error, tail: output.split("\n").slice(-6).join("\n") });
    });
  });
}

function schemaRead(side, store) {
  const { checkout, node } = sides[side];
  const out = execFileSync(node, ["--import", "tsx", join(here, "schema-read.js"), checkout, store], {
    cwd: checkout,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

const report = await rehearse({
  work,
  entry: options.entry,
  checkouts: Object.values(sides).map(({ checkout }) => checkout),
  describe,
  run,
  schemaRead,
});
if (report.status !== "passed") process.exitCode = 1;
