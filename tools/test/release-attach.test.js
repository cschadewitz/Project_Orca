/** release-attach.sh against a stateful fake `gh`: attach only to the exact draft it selected. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ATTACH = resolve("tools/deploy/release-attach.sh");
const FEED_AUTO = resolve("tools/deploy/feed-auto.sh");

// A tiny GitHub: releases, run artifacts and signed runs live in FAKE_STATE and change as the
// script writes. `workflow run` and every write are logged to FAKE_LOG. FAKE_PUBLISH_AT_READ=k
// publishes the release on the k-th read of `releases/ID` (before answering it), which is how
// a person publishing the draft mid-run looks to the script.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
if (args[0] === "workflow") { log(args); process.exit(0); }
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
const save = () => fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
const x = args.indexOf("-X");
const method = x < 0 ? "GET" : args[x + 1];
const url = args.find((a) => a.startsWith("repos/") || a.startsWith("https://"));
const path = url.replace(/^https:\/\/uploads\.github\.com\//, "").replace(/^repos\/o\/r\//, "");
const input = () => { const i = args.indexOf("--input"); return args[i + 1] === "-" ? fs.readFileSync(0) : fs.readFileSync(args[i + 1]); };
const byId = (id) => state.releases.find((r) => String(r.id) === id);
let out;
let m;
if (method === "POST" && (m = path.match(/^releases\/(\d+)\/assets\?name=(.+)$/))) {
  const r = byId(m[1]);
  const digest = "sha256:" + crypto.createHash("sha256").update(input()).digest("hex");
  r.assets.push({ name: m[2], digest });
  log(["upload", m[1], m[2]]);
  out = {};
} else if ((m = path.match(/^releases\/(\d+)$/))) {
  const r = byId(m[1]);
  if (!r) { process.stderr.write("HTTP 404\n"); process.exit(1); }
  if (method === "PATCH") {
    Object.assign(r, JSON.parse(input().toString()));
    log(["patch", m[1]]);
  } else {
    state.reads = (state.reads || 0) + 1;
    if (String(state.reads) === process.env.FAKE_PUBLISH_AT_READ) {
      r.draft = false;
      r.published_at = "2026-11-21T22:00:00Z";
    }
  }
  out = r;
} else if ((m = path.match(/^releases\/tags\/(.+)$/))) {
  out = state.releases.find((r) => r.tag_name === m[1]);
} else if (/^releases(\?|$)/.test(path)) {
  out = state.releases;
} else if ((m = path.match(/^actions\/runs\/(\d+)\/artifacts/))) {
  out = { artifacts: state.artifacts[m[1]] || [] };
} else if (path.startsWith("actions/workflows/windows-signed.yml/runs")) {
  out = { workflow_runs: state.signedRuns.map((id) => ({ id })) };
}
if (out === undefined) { process.stderr.write("HTTP 404 " + path + "\n"); process.exit(1); }
save();
const json = JSON.stringify(out);
const q = args.indexOf("--jq");
process.stdout.write(q < 0 ? json + "\n" : execFileSync("jq", ["-r", args[q + 1]], { input: json }));
`;

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const SHA = "c".repeat(40);
const OTHER = "e".repeat(40);
const DEB = { name: "ORCA-0.8.0-linux-amd64.deb", digest: "sha256:" + "d".repeat(64) };
const draft = (over = {}) => ({
  id: 7,
  tag_name: "v0.8.0",
  name: "v0.8.0",
  draft: true,
  prerelease: false,
  published_at: null,
  target_commitish: SHA,
  body: "Notes.",
  assets: [DEB],
  ...over,
});
const artifact = (sha = SHA, expired = false) => ({ name: `windows-signed-${sha}`, expired });

function setup({ releases = [draft()], artifacts = { 100: [artifact()] }, signedRuns = [100] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orca-release-attach-"));
  dirs.push(root);
  writeFileSync(join(root, "gh"), FAKE_GH);
  chmodSync(join(root, "gh"), 0o755);
  writeFileSync(join(root, "state.json"), JSON.stringify({ releases, artifacts, signedRuns }));
  writeFileSync(join(root, "log"), "");
  mkdirSync(join(root, "signed"));
  const exe = join(root, "signed", "ORCA-0.8.0-win-x64.exe");
  writeFileSync(exe, "signed installer bytes");
  const digest = "sha256:" + createHash("sha256").update("signed installer bytes").digest("hex");
  const run = (script, args, env = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        FAKE_STATE: join(root, "state.json"),
        FAKE_LOG: join(root, "log"),
        REPO: "o/r",
        GITHUB_STEP_SUMMARY: "",
        ...env,
      },
    });
  const attach = (env) => run(ATTACH, ["attach", "7", SHA, "0.8.0", "100", exe], env);
  const state = () => JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  const writes = () =>
    readFileSync(join(root, "log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { run, attach, state, writes, digest, marker: `<!-- orca-signed-run: 100 ${digest} -->` };
}

describe.skipIf(process.platform === "win32")("release-attach.sh", () => {
  it("selects the one final draft at the signed commit", () => {
    const f = setup();
    const result = f.run(ATTACH, ["select", "100"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`artifact=windows-signed-${SHA}\nsha=${SHA}\nid=7\nversion=0.8.0\n`);
  });

  it("selects nothing without a draft or an unexpired artifact, and refuses two drafts", () => {
    expect(setup({ releases: [] }).run(ATTACH, ["select", "100"]).stdout).not.toContain("id=");
    expect(setup({ artifacts: { 100: [artifact(SHA, true)] } }).run(ATTACH, ["select", "100"]).stdout).not.toContain(
      "id=",
    );
    const two = setup({ releases: [draft(), draft({ id: 8 })] }).run(ATTACH, ["select", "100"]);
    expect(two.status).not.toBe(0);
    expect(two.stderr).toContain("2 final drafts");
  });

  it("uploads, records the run and reads both back; a rerun writes nothing", () => {
    const f = setup();
    const first = f.attach();
    expect(first.status, first.stderr).toBe(0);
    const r = f.state().releases[0];
    expect(r.assets.map((a) => a.digest)).toEqual([DEB.digest, f.digest]);
    expect(r.body).toBe(`Notes.\n\n${f.marker}`);
    expect(f.writes()).toEqual([
      ["upload", "7", "ORCA-0.8.0-win-x64.exe"],
      ["patch", "7"],
    ]);
    expect(f.attach().status).toBe(0);
    expect(f.writes()).toHaveLength(2);
  });

  it("writes nothing to a draft published between selection and the first write", () => {
    const f = setup();
    const result = f.attach({ FAKE_PUBLISH_AT_READ: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no longer a draft; nothing written");
    expect(f.writes()).toEqual([]);
  });

  it("does not record a run on a draft published between the upload and the record", () => {
    // Reads: validate, existing asset, validate (published here), so no PATCH follows.
    const f = setup();
    const result = f.attach({ FAKE_PUBLISH_AT_READ: "3" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no longer a draft");
    expect(f.writes()).toEqual([["upload", "7", "ORCA-0.8.0-win-x64.exe"]]);
    expect(f.state().releases[0].body).toBe("Notes.");
  });

  it.each([
    ["a changed target", { target_commitish: OTHER }, "no longer targets"],
    ["a renamed draft", { name: "v0.8.1" }, "no longer named v0.8.0"],
    ["a prerelease", { prerelease: true }, "is a prerelease"],
    ["an extra asset", { assets: [DEB, { name: "extra.zip", digest: "sha256:0" }] }, "unexpected assets"],
    ["a missing .deb", { assets: [] }, "unexpected assets"],
    ["another run's record", { body: `<!-- orca-signed-run: 99 sha256:${"f".repeat(64)} -->` }, "another signing run"],
  ])("refuses %s before writing", (_label, over, message) => {
    const f = setup({ releases: [draft(over)] });
    const result = f.attach();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(f.writes()).toEqual([]);
  });

  it("refuses an installer of that name with other bytes", () => {
    const f = setup({ releases: [draft({ assets: [DEB, { name: "ORCA-0.8.0-win-x64.exe", digest: "sha256:0" }] })] });
    const result = f.attach();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already has ORCA-0.8.0-win-x64.exe");
    expect(f.writes()).toEqual([]);
  });

  it("recovers an interrupted attachment through reconcile, attach and the feed", () => {
    // The attach was cancelled after uploading and before recording. Run 300 signed another
    // commit and run 200's artifact expired; 100 still holds this commit's signed build.
    const f = setup({
      artifacts: { 300: [artifact(OTHER)], 200: [artifact(SHA, true)], 100: [artifact()] },
      signedRuns: [300, 200, 100],
    });
    const s = f.state();
    s.releases[0].assets.push({ name: "ORCA-0.8.0-win-x64.exe", digest: f.digest });
    const root = dirs[dirs.length - 1];
    writeFileSync(join(root, "state.json"), JSON.stringify(s));

    const reconcile = f.run(ATTACH, ["reconcile"]);
    expect(reconcile.status, reconcile.stderr).toBe(0);
    expect(f.writes()).toEqual([
      ["workflow", "run", "release-attach-signed.yml", "--repo", "o/r", "--ref", "main", "-f", "signed_run_id=100"],
    ]);

    const attached = f.attach();
    expect(attached.status, attached.stderr).toBe(0);
    expect(f.writes().slice(1)).toEqual([["patch", "7"]]);

    // Published after acceptance: the feed takes exactly run 100.
    const p = f.state();
    p.releases[0].draft = false;
    p.releases[0].published_at = "2026-11-21T22:00:00Z";
    writeFileSync(join(root, "state.json"), JSON.stringify(p));
    const fed = f.run(FEED_AUTO, [], { EVENT: "release", RELEASE_TAG: "v0.8.0" });
    expect(fed.status, fed.stderr).toBe(0);
    expect(f.writes().slice(2)).toEqual([
      [
        "workflow",
        "run",
        "feed-publish.yml",
        "--repo",
        "o/r",
        "--ref",
        "main",
        "-f",
        "version=0.8.0",
        "-f",
        "signed_run_id=100",
      ],
    ]);

    // Nothing left to reconcile.
    p.releases[0].draft = true;
    writeFileSync(join(root, "state.json"), JSON.stringify(p));
    f.run(ATTACH, ["reconcile"]);
    expect(f.writes()).toHaveLength(3);
  });

  it("reconciles only finals, and waits while no signed run has the artifact", () => {
    const f = setup({
      releases: [
        draft({ id: 1, prerelease: true }),
        draft({ id: 2, name: "v0.8.0-rc.1" }),
        draft({ id: 3, target_commitish: OTHER, name: "v0.9.0" }),
      ],
    });
    const result = f.run(ATTACH, ["reconcile"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("v0.9.0 (release 3): no unexpired signed run");
    expect(f.writes()).toEqual([]);
  });
});
