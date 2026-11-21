/** feed-auto.sh against a fake `gh` and a throwaway Git repository: pairing release and signed run. */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("tools/deploy/feed-auto.sh");
// Answers the few API reads feed-auto.sh makes from FAKE_STATE, and logs `gh workflow run`.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "workflow") { fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\n"); process.exit(0); }
const path = args[1];
const jq = args[args.indexOf("--jq") + 1];
let m;
if (/workflows\/windows-signed\.yml\/runs/.test(path)) {
  state.runs.forEach((r) => console.log(r.id));
} else if ((m = /runs\/(\d+)\/artifacts/.exec(path))) {
  const run = state.runs.find((r) => String(r.id) === m[1]) ?? { artifacts: [] };
  const names = run.artifacts.filter((a) => !a.expired).map((a) => a.name);
  if (jq.startsWith("[")) console.log(names.find((n) => /^windows-signed-[0-9a-f]{40}$/.test(n)) ?? "");
  else names.filter((n) => jq.includes('"' + n + '"')).forEach(() => console.log(1));
} else if ((m = /releases\/tags\/(.+)$/.exec(path))) {
  const rel = state.releases[m[1]];
  if (!rel) process.exit(1);
  if (!rel.draft) console.log(m[1]);
} else process.exit(2);
`;

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(state) {
  const root = mkdtempSync(join(tmpdir(), "orca-feed-auto-"));
  dirs.push(root);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x");
  const sha = git("rev-parse", "HEAD");
  git("tag", "v0.7.0");
  writeFileSync(join(root, "gh"), FAKE_GH);
  chmodSync(join(root, "gh"), 0o755);
  const stateFile = join(root, "state.json");
  writeFileSync(stateFile, JSON.stringify(state(sha)));
  const log = join(root, "log");
  writeFileSync(log, "");
  const run = (env) =>
    spawnSync("bash", [SCRIPT], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        FAKE_STATE: stateFile,
        FAKE_LOG: log,
        REPO: "o/r",
        ...env,
      },
    });
  const dispatched = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { sha, run, dispatched };
}

const signed = (id, sha, expired = false) => ({ id, artifacts: [{ name: `windows-signed-${sha}`, expired }] });

describe.skipIf(process.platform === "win32")("feed-auto.sh", () => {
  it("on a published release, dispatches the feed with the signed run of the tag's commit", () => {
    const f = setup((sha) => ({ runs: [signed(7, "f".repeat(40)), signed(5, sha)], releases: { "v0.7.0": {} } }));
    const result = f.run({ EVENT: "release", RELEASE_TAG: "v0.7.0" });
    expect(result.status, result.stderr).toBe(0);
    expect(f.dispatched()).toEqual([
      [
        "workflow",
        "run",
        "feed-publish.yml",
        "--repo",
        "o/r",
        "--ref",
        "main",
        "-f",
        "version=0.7.0",
        "-f",
        "signed_run_id=5",
      ],
    ]);
  });

  it("on a published release with no (unexpired) signed run, waits without failing", () => {
    const f = setup((sha) => ({ runs: [signed(5, sha, true)], releases: { "v0.7.0": {} } }));
    const result = f.run({ EVENT: "release", RELEASE_TAG: "v0.7.0" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("feed runs when one completes");
    expect(f.dispatched()).toEqual([]);
  });

  it("on a signed run, dispatches only once the commit's release is published", () => {
    const published = setup((sha) => ({ runs: [signed(9, sha)], releases: { "v0.7.0": {} } }));
    expect(published.run({ EVENT: "workflow_run", SIGNED_RUN_ID: "9" }).status).toBe(0);
    expect(published.dispatched()[0]).toContain("signed_run_id=9");
    expect(published.dispatched()[0]).toContain("version=0.7.0");

    const draft = setup((sha) => ({ runs: [signed(9, sha)], releases: { "v0.7.0": { draft: true } } }));
    const waiting = draft.run({ EVENT: "workflow_run", SIGNED_RUN_ID: "9" });
    expect(waiting.status, waiting.stderr).toBe(0);
    expect(waiting.stdout).toContain("no published release yet");
    expect(draft.dispatched()).toEqual([]);
  });

  it("refuses bad inputs", () => {
    const f = setup(() => ({ runs: [], releases: {} }));
    expect(f.run({ EVENT: "release", RELEASE_TAG: "latest" }).status).not.toBe(0);
    expect(f.run({ EVENT: "workflow_run", SIGNED_RUN_ID: "x" }).status).not.toBe(0);
    expect(f.run({ EVENT: "push" }).status).not.toBe(0);
    expect(f.dispatched()).toEqual([]);
  });
});
