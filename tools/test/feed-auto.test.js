/** feed-auto.sh against a fake `gh`: feed exactly the signing run a release recorded. */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("tools/deploy/feed-auto.sh");
// `gh api PATH [--jq F]` answers from FAKE_STATE (path -> JSON), filtered by the real jq;
// `gh workflow run ...` is logged to FAKE_LOG.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "workflow") { fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\n"); process.exit(0); }
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
const path = args[1].replace(/^repos\/o\/r\//, "");
if (!(path in state)) { process.stderr.write("HTTP 404\n"); process.exit(1); }
const json = JSON.stringify(state[path]);
const i = args.indexOf("--jq");
process.stdout.write(i < 0 ? json + "\n" : execFileSync("jq", ["-r", args[i + 1]], { input: json }));
`;

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const A = "sha256:" + "a".repeat(64);
const B = "sha256:" + "b".repeat(64);
const recorded = (run, digest) => `Notes.\n\n<!-- orca-signed-run: ${run} ${digest} -->`;
const release = (tag, { body = "", digest = A, draft = false, published = "2026-11-21T22:00:00Z" } = {}) => ({
  tag_name: tag,
  draft,
  published_at: draft ? null : published,
  body,
  assets: [
    { name: `ORCA-${tag.slice(1)}-linux-amd64.deb`, digest: "sha256:" + "d".repeat(64) },
    { name: `ORCA-${tag.slice(1)}-win-x64.exe`, digest },
  ],
});

function setup(state) {
  const root = mkdtempSync(join(tmpdir(), "orca-feed-auto-"));
  dirs.push(root);
  writeFileSync(join(root, "gh"), FAKE_GH);
  chmodSync(join(root, "gh"), 0o755);
  writeFileSync(join(root, "state.json"), JSON.stringify(state));
  writeFileSync(join(root, "log"), "");
  const run = (env) =>
    spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        FAKE_STATE: join(root, "state.json"),
        FAKE_LOG: join(root, "log"),
        REPO: "o/r",
        ...env,
      },
    });
  const dispatched = () =>
    readFileSync(join(root, "log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { run, dispatched };
}

const feed = (version, run) => [
  "workflow",
  "run",
  "feed-publish.yml",
  "--repo",
  "o/r",
  "--ref",
  "main",
  "-f",
  `version=${version}`,
  "-f",
  `signed_run_id=${run}`,
];

describe.skipIf(process.platform === "win32")("feed-auto.sh", () => {
  it("feeds the run the release recorded, not a newer run for the same commit", () => {
    // Run 200 signed the same commit later with different bytes; only 100's were published.
    const f = setup({ "releases/tags/v0.8.0": release("v0.8.0", { body: recorded(100, A), digest: A }) });
    const result = f.run({ EVENT: "release", RELEASE_TAG: "v0.8.0" });
    expect(result.status, result.stderr).toBe(0);
    expect(f.dispatched()).toEqual([feed("0.8.0", "100")]);
  });

  it("does not feed when the published installer is not the recorded one", () => {
    const f = setup({ "releases/tags/v0.8.0": release("v0.8.0", { body: recorded(100, A), digest: B }) });
    const result = f.run({ EVENT: "release", RELEASE_TAG: "v0.8.0" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("not the one signed run 100 recorded");
    expect(f.dispatched()).toEqual([]);
  });

  it.each([
    ["no record", ""],
    ["two records", recorded(100, A) + "\n" + recorded(101, A)],
  ])("leaves a release with %s for a manual dispatch", (_label, body) => {
    const f = setup({ "releases/tags/v0.8.0": release("v0.8.0", { body }) });
    const result = f.run({ EVENT: "release", RELEASE_TAG: "v0.8.0" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("dispatch feed-publish.yml by hand");
    expect(f.dispatched()).toEqual([]);
  });

  it("reconciles every recent published release, each on its own record", () => {
    const recent = new Date(Date.now() - 2 * 86400e3).toISOString().replace(/\.\d+Z$/, "Z");
    const old = new Date(Date.now() - 9 * 86400e3).toISOString().replace(/\.\d+Z$/, "Z");
    const r1 = release("v0.8.0", { body: recorded(100, A), published: recent });
    const r2 = release("v0.8.1", { body: recorded(300, B), digest: B, published: recent });
    const r3 = release("v0.7.9", { body: recorded(50, A), published: old });
    const draft = release("v0.9.0", { body: recorded(400, A), draft: true });
    const f = setup({
      "releases?per_page=30": [draft, r2, r1, r3],
      "releases/tags/v0.8.0": r1,
      "releases/tags/v0.8.1": r2,
    });
    const result = f.run({ EVENT: "schedule" });
    expect(result.status, result.stderr).toBe(0);
    expect(f.dispatched()).toEqual([feed("0.8.1", "300"), feed("0.8.0", "100")]);
  });

  it("refuses bad inputs", () => {
    const f = setup({});
    expect(f.run({ EVENT: "release", RELEASE_TAG: "latest" }).status).not.toBe(0);
    expect(f.run({ EVENT: "push" }).status).not.toBe(0);
    expect(f.dispatched()).toEqual([]);
  });
});
