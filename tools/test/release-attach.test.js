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
if (args[0] === "run" && args[1] === "download") {
  const evidence = (state.evidence || {})[args[2]];
  if (!evidence) { process.stderr.write("no artifact\n"); process.exit(1); }
  const dir = args[args.indexOf("--dir") + 1];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + "/evidence.json", JSON.stringify(evidence));
  process.exit(0);
}
const save = () => fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
const x = args.indexOf("-X");
const method = x < 0 ? "GET" : args[x + 1];
const url = args.find((a) => a.startsWith("repos/") || a.startsWith("https://"));
const path = url.replace(/^https:\/\/uploads\.github\.com\//, "").replace(/^repos\/o\/r\//, "");
const input = () => { const i = args.indexOf("--input"); return args[i + 1] === "-" ? fs.readFileSync(0) : fs.readFileSync(args[i + 1]); };
if (process.env.FAKE_ERROR_PATH && new RegExp(process.env.FAKE_ERROR_PATH).test(path)) {
  process.stderr.write("gh: Service Unavailable (HTTP 503)\n");
  process.exit(1);
}
const byId = (id) => state.releases.find((r) => String(r.id) === id);
let out;
let m;
if (method === "GET" && args.includes("Accept: application/octet-stream") && (m = path.match(/^releases\/assets\/(\d+)$/))) {
  const asset = state.releases.flatMap((r) => r.assets).find((a) => String(a.id) === m[1]);
  if (!asset || asset.content === undefined) { process.stderr.write("HTTP 404\n"); process.exit(1); }
  process.stdout.write(asset.content);
  process.exit(0);
}
if ((m = path.match(/^compare\/([0-9a-f]+)\.\.\.main$/))) {
  out = { status: (state.onMain || []).includes(m[1]) ? "ahead" : "diverged" };
} else
if (method === "DELETE" && (m = path.match(/^releases\/assets\/(\d+)$/))) {
  for (const r of state.releases) r.assets = r.assets.filter((a) => String(a.id) !== m[1]);
  log(["delete", m[1]]);
  out = {};
} else if (method === "POST" && (m = path.match(/^releases\/(\d+)\/assets\?name=(.+)$/))) {
  const r = byId(m[1]);
  const digest = "sha256:" + crypto.createHash("sha256").update(input()).digest("hex");
  state.nextAsset = (state.nextAsset || 1000) + 1;
  r.assets.push({ id: state.nextAsset, name: m[2], digest, content: input().toString() });
  log(["upload", m[1], m[2]]);
  out = {};
} else if ((m = path.match(/^releases\/(\d+)$/))) {
  const r = byId(m[1]);
  if (!r) { process.stderr.write("HTTP 404\n"); process.exit(1); }
  if (method === "PATCH") {
    const fields = {};
    args.forEach((a, i) => {
      if (a === "-f") { const [k, ...v] = args[i + 1].split("="); fields[k] = v.join("="); }
      if (a === "-F") { const [k, ...v] = args[i + 1].split("="); fields[k] = JSON.parse(v.join("=")); }
    });
    Object.assign(r, args.includes("--input") ? JSON.parse(input().toString()) : fields);
    if (fields.draft === false) {
      r.published_at = "2026-11-21T22:00:00Z";
      state.tags[r.tag_name] = r.target_commitish;
      state.latest = r.id;
    }
    log(["patch", m[1], ...Object.keys(fields)]);
  } else {
    state.reads = (state.reads || 0) + 1;
    if (String(state.reads) === process.env.FAKE_PUBLISH_AT_READ) {
      r.draft = false;
      r.published_at = "2026-11-21T22:00:00Z";
    }
  }
  out = r;
} else if (path === "releases/latest") {
  out = byId(String(state.latest));
} else if ((m = path.match(/^git\/ref\/tags\/(.+)$/))) {
  if (state.tags[m[1]]) out = { object: { sha: state.tags[m[1]] } };
} else if ((m = path.match(/^actions\/runs\/(\d+)$/))) {
  out = state.runs[m[1]];
} else if ((m = path.match(/^actions\/runs\/(\d+)\/jobs/))) {
  if (state.runs[m[1]]) out = { jobs: (state.jobs || {})[m[1]] || [] };
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
// A final draft already carries its signed server bundle (#876): the three files, the record
// naming run 55, and run 55 itself (a successful Release (server bundle) run for v0.8.0 at SHA).
const sha256 = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
const serverNames = (version = "0.8.0") =>
  ["tar.xz", "manifest.json", "manifest.json.sigstore.json"].map((ext) => `orca-server-${version}-linux-x64.${ext}`);
const serverFiles = (version = "0.8.0", sha = SHA, tag = "bundle") => {
  const [archive, manifest, signature] = serverNames(version);
  const archiveContent = `${tag} archive ${version}`;
  const manifestContent = JSON.stringify({
    schema: "orca-server-bundle/1",
    version,
    sourceSha: sha,
    platform: "linux-x64",
    archive: { name: archive, sha256: sha256(archiveContent).slice(7) },
  });
  return [
    [archive, archiveContent],
    [manifest, manifestContent],
    [signature, `${tag} sigstore bundle`],
  ].map(([name, content], i) => ({ id: 901 + i, name, digest: sha256(content), content }));
};
const SERVER = serverFiles();
const serverRecord = (run = 55, files = SERVER) =>
  `<!-- orca-server-run: ${run} ${files.map((a) => a.digest).join(" ")} -->`;
const SERVER_RECORD = serverRecord();
const serverRun = (version = "0.8.0", sha = SHA) => ({
  path: ".github/workflows/release-server-bundle.yml",
  repository: { full_name: "o/r" },
  head_repository: { full_name: "o/r" },
  event: "workflow_dispatch",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  display_title: `Release (server bundle) v${version} at ${sha}`,
});
const serverReceipt = (id = 7, version = "0.8.0", sha = SHA, files = SERVER) =>
  `server bundle receipt: release ${id} v${version} ${sha} ` +
  sha256(
    `orca-server-receipt/1 release=${id} version=${version} sha=${sha} files=${files.map((a) => a.digest).join(" ")}`,
  );
const SERVER_JOBS = ["sign the manifest (keyless, GitHub OIDC)", "stage --bundle on a clean host", serverReceipt()].map(
  (name) => ({ name, status: "completed", conclusion: "success" }),
);
const draft = (over = {}) => ({
  id: 7,
  tag_name: "v0.8.0",
  name: "v0.8.0",
  draft: true,
  prerelease: false,
  published_at: null,
  target_commitish: SHA,
  body: `Notes.\n\n${SERVER_RECORD}`,
  assets: [DEB, ...SERVER],
  ...over,
});
const artifact = (sha = SHA, expired = false) => ({ name: `windows-signed-${sha}`, expired });

const goodRun = {
  path: ".github/workflows/windows-signed.yml",
  repository: { full_name: "o/r" },
  head_repository: { full_name: "o/r" },
  event: "workflow_dispatch",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
};

function setup({
  releases = [draft()],
  artifacts = { 100: [artifact()] },
  signedRuns = [100],
  runs = Object.fromEntries(Object.keys(artifacts).map((id) => [id, goodRun])),
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "orca-release-attach-"));
  dirs.push(root);
  writeFileSync(join(root, "gh"), FAKE_GH);
  chmodSync(join(root, "gh"), 0o755);
  writeFileSync(
    join(root, "state.json"),
    JSON.stringify({
      releases,
      artifacts,
      signedRuns,
      runs: { 55: serverRun(), ...runs },
      jobs: { 55: SERVER_JOBS },
      tags: {},
    }),
  );
  writeFileSync(join(root, "log"), "");
  mkdirSync(join(root, "signed"));
  const exe = join(root, "signed", "ORCA-0.8.0-win-x64.exe");
  writeFileSync(exe, "signed installer bytes");
  const digest = "sha256:" + createHash("sha256").update("signed installer bytes").digest("hex");
  const armExe = join(root, "signed", "ORCA-0.8.0-win-arm64.exe");
  writeFileSync(armExe, "signed arm64 installer bytes");
  const armDigest = "sha256:" + createHash("sha256").update("signed arm64 installer bytes").digest("hex");
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
  // x64 only, as before #889; attachBoth is what release-attach-signed.yml runs now.
  const attach = (env, runId = "100") => run(ATTACH, ["attach", "7", SHA, "0.8.0", runId, exe], env);
  const attachBoth = (env, runId = "100") => run(ATTACH, ["attach", "7", SHA, "0.8.0", runId, exe, armExe], env);
  const accept = (env, digestArg = armDigest) => run(ATTACH, ["accept", "7", SHA, "0.8.0", "900", digestArg], env);
  const state = () => JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  const edit = (fn) => {
    const st = state();
    fn(st);
    st.reads = 0;
    writeFileSync(join(root, "state.json"), JSON.stringify(st));
  };
  const writes = () =>
    readFileSync(join(root, "log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const marker = (runId = 100) => `<!-- orca-signed-run: ${runId} ${digest} -->`;
  const armMarker = (runId = 100) => `<!-- orca-signed-run-arm64: ${runId} ${armDigest} -->`;
  const acceptMarker = (runId = 900, d = armDigest) => `<!-- orca-arm64-accepted: ${runId} ${d} -->`;
  // What a real acceptance run leaves: its run facts and its evidence artifact.
  const evidence = (over = {}) => ({
    format: 1,
    run_id: "900",
    release_id: "7",
    version: "0.8.0",
    source_sha: SHA,
    digest: armDigest,
    mode: "fresh",
    previous: null,
    ...over,
  });
  const acceptRun = (over = {}) => ({
    ...goodRun,
    id: 900,
    path: ".github/workflows/release-accept-arm64.yml",
    event: "workflow_run",
    ...over,
  });
  const accepted = (env, { run: runOver = {}, evidence: evidenceOver = {} } = {}) => {
    const result = accept(env);
    edit((st) => {
      st.runs["900"] = acceptRun(runOver);
      st.evidence = { 900: evidence(evidenceOver) };
    });
    return result;
  };
  const x64Only = () => run(ATTACH, ["x64-only", "7", SHA, "0.8.0"]);
  return {
    run,
    attach,
    attachBoth,
    accept,
    accepted,
    x64Only,
    state,
    edit,
    writes,
    digest,
    armDigest,
    marker,
    armMarker,
    acceptMarker,
  };
}

const UPLOAD = ["upload", "7", "ORCA-0.8.0-win-x64.exe"];
const UPLOAD_ARM = ["upload", "7", "ORCA-0.8.0-win-arm64.exe"];
const RECORD = ["patch", "7"];
const dispatchAttach = (runId) => [
  "workflow",
  "run",
  "release-attach-signed.yml",
  "--repo",
  "o/r",
  "--ref",
  "main",
  "-f",
  `signed_run_id=${runId}`,
];

describe.skipIf(process.platform === "win32")("release-attach.sh", () => {
  it("selects the one final draft at the signed commit, printing only output assignments", () => {
    const f = setup();
    const result = f.run(ATTACH, ["select", "100"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`artifact=windows-signed-${SHA}\nsha=${SHA}\nid=7\nversion=0.8.0\n`);
  });

  it.each([
    ["another workflow", { path: ".github/workflows/ci.yml" }],
    ["another repository", { head_repository: { full_name: "fork/r" } }],
    ["a push", { event: "push" }],
    ["another branch", { head_branch: "topic" }],
    ["a failed run", { conclusion: "failure" }],
    ["a running run", { status: "in_progress", conclusion: null }],
  ])("selects nothing from %s, with nothing on stdout", (_label, over) => {
    const f = setup({ runs: { 100: { ...goodRun, ...over } } });
    const result = f.run(ATTACH, ["select", "100"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not a successful Windows signed (spike) run dispatched from main");
  });

  it("selects nothing without a draft, with an expired or a second artifact, and refuses two drafts", () => {
    for (const f of [
      setup({ releases: [] }),
      setup({ artifacts: { 100: [artifact(SHA, true)] } }),
      setup({ artifacts: { 100: [artifact(), artifact(OTHER)] } }),
    ]) {
      const result = f.run(ATTACH, ["select", "100"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
    }
    const two = setup({ releases: [draft(), draft({ id: 8 })] }).run(ATTACH, ["select", "100"]);
    expect(two.status).not.toBe(0);
    expect(two.stderr).toContain("2 final drafts");
  });

  it("records the run first, then uploads, and reads both back; a rerun writes nothing", () => {
    const f = setup();
    const first = f.attach();
    expect(first.status, first.stderr).toBe(0);
    const r = f.state().releases[0];
    expect(r.assets.map((a) => a.digest)).toEqual([DEB.digest, ...SERVER.map((a) => a.digest), f.digest]);
    expect(r.body).toBe(`Notes.\n\n${SERVER_RECORD}\n\n${f.marker()}`);
    expect(f.writes()).toEqual([RECORD, UPLOAD]);
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

  it("does not upload to a draft published between the record and the upload", () => {
    // Reads: validate, then validate again (published here), so no upload follows.
    const f = setup();
    const result = f.attach({ FAKE_PUBLISH_AT_READ: "2" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no longer a draft");
    expect(f.writes()).toEqual([RECORD]);
    expect(f.state().releases[0].assets).toEqual([DEB, ...SERVER]);
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
  });

  it("resumes an interrupted upload with the recorded run, not a newer one, through to the feed", () => {
    // The attach recorded run 100 and was interrupted before uploading. Run 200 signed the same
    // commit later (different bytes), and 300 another commit.
    const f = setup({
      artifacts: { 300: [artifact(OTHER)], 200: [artifact()], 100: [artifact()] },
      signedRuns: [300, 200, 100],
    });
    f.edit((st) => (st.releases[0].body = `Notes.\n\n${SERVER_RECORD}\n\n${f.marker(100)}\n\n${f.armMarker(100)}`));

    // Run 200's own attach (its workflow_run) is refused: the draft names 100.
    const newer = f.attachBoth({}, "200");
    expect(newer.status).not.toBe(0);
    expect(newer.stderr).toContain("another signing run");

    const reconcile = f.run(ATTACH, ["reconcile"]);
    expect(reconcile.status, reconcile.stderr).toBe(0);
    expect(f.writes()).toEqual([dispatchAttach(100)]);

    expect(f.attachBoth().status).toBe(0);
    expect(f.writes().slice(1)).toEqual([UPLOAD, UPLOAD_ARM]);

    // Nothing left to reconcile.
    f.run(ATTACH, ["reconcile"]);
    expect(f.writes()).toHaveLength(3);

    // arm64's native acceptance is recorded, then publication through the workflow's script,
    // then the feed takes exactly run 100.
    const acceptance = f.accepted();
    expect(acceptance.status, acceptance.stderr).toBe(0);
    expect(f.writes().slice(3)).toEqual([RECORD]);
    const published = f.run(ATTACH, ["publish", "7", "0.8.0", SHA, DEB.digest, f.digest]);
    expect(published.status, published.stderr).toBe(0);
    expect(published.stderr).toContain("ORCA-0.8.0-win-arm64.exe");
    expect(f.writes().slice(4)).toEqual([["patch", "7", "tag_name", "target_commitish", "draft", "make_latest"]]);
    const fed = f.run(FEED_AUTO, [], { EVENT: "release", RELEASE_TAG: "v0.8.0" });
    expect(fed.status, fed.stderr).toBe(0);
    expect(f.writes().at(-1)).toEqual([
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
    ]);
  });

  it("attaches both installers after one record write, and a rerun writes nothing", () => {
    const f = setup();
    const first = f.attachBoth();
    expect(first.status, first.stderr).toBe(0);
    const r = f.state().releases[0];
    expect(r.assets.map((a) => a.digest)).toEqual([DEB.digest, ...SERVER.map((a) => a.digest), f.digest, f.armDigest]);
    expect(r.body).toBe(`Notes.\n\n${SERVER_RECORD}\n\n${f.marker()}\n\n${f.armMarker()}`);
    expect(f.writes()).toEqual([RECORD, UPLOAD, UPLOAD_ARM]);
    expect(f.attachBoth().status).toBe(0);
    expect(f.writes()).toHaveLength(3);
  });

  it("adds arm64 to a draft attached x64-only before #889, through reconcile", () => {
    const f = setup();
    expect(f.attach().status).toBe(0);
    expect(f.run(ATTACH, ["reconcile"]).status).toBe(0);
    expect(f.writes().at(-1)).toEqual(dispatchAttach(100));
    expect(f.attachBoth().status).toBe(0);
    expect(f.writes().slice(3)).toEqual([RECORD, UPLOAD_ARM]);
    expect(f.state().releases[0].body).toBe(`Notes.\n\n${SERVER_RECORD}\n\n${f.marker()}\n\n${f.armMarker()}`);
  });

  it("refuses an arm64 installer with other bytes or another run's arm64 record", () => {
    const other = setup({
      releases: [draft({ assets: [DEB, { name: "ORCA-0.8.0-win-arm64.exe", digest: "sha256:0" }] })],
    });
    // The x64 installer is not there yet, so arm64 alone is an unexpected set.
    expect(other.attachBoth().stderr).toContain("unexpected assets");
    const record = setup({
      releases: [draft({ body: `<!-- orca-signed-run-arm64: 99 sha256:${"f".repeat(64)} -->` })],
    });
    const result = record.attachBoth();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("another signing run for arm64");
    expect(record.writes()).toEqual([]);
  });

  it("selects the draft waiting for arm64 acceptance, with the asset to download", () => {
    const f = setup();
    expect(f.run(ATTACH, ["accept-select"]).stdout).toBe("");
    expect(f.attachBoth().status).toBe(0);
    const asset = f.state().releases[0].assets.findIndex((a) => a.name === "ORCA-0.8.0-win-arm64.exe");
    f.edit((st) => (st.releases[0].assets[asset].id = 4242));
    const selected = f.run(ATTACH, ["accept-select"]);
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout).toBe(`id=7\nsha=${SHA}\nversion=0.8.0\ndigest=${f.armDigest}\nasset=4242\n`);
    expect(f.run(ATTACH, ["accept-select", "8"]).stdout).toBe("");
    expect(f.accept().status).toBe(0);
    const after = f.run(ATTACH, ["accept-select"]);
    expect(after.stdout).toBe("");
    expect(after.stderr).toContain("already recorded");
  });

  it("records acceptance once, only for the attached recorded arm64 bytes", () => {
    const f = setup();
    expect(f.attachBoth().status).toBe(0);
    const wrong = f.accept({}, "sha256:" + "9".repeat(64));
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain("arm64 signing record is not");
    expect(f.writes()).toHaveLength(3);
    expect(f.accept().status).toBe(0);
    expect(f.state().releases[0].body).toContain(f.acceptMarker());
    expect(f.accept().status).toBe(0);
    expect(f.writes()).toHaveLength(4);
  });

  it("refuses to record acceptance on a draft published meanwhile, or beside other bytes' acceptance", () => {
    const published = setup();
    expect(published.attachBoth().status).toBe(0);
    published.edit(() => {}); // count reads from here
    const result = published.accept({ FAKE_PUBLISH_AT_READ: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no longer a draft");
    expect(published.writes()).toHaveLength(3);

    const other = setup();
    expect(other.attachBoth().status).toBe(0);
    other.edit((st) => (st.releases[0].body += `\n\n${other.acceptMarker(901, "sha256:" + "8".repeat(64))}`));
    const refused = other.accept();
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("acceptance of other arm64 bytes");
  });

  it("refuses to publish an attached arm64 installer without its acceptance record", () => {
    const f = setup();
    expect(f.attachBoth().status).toBe(0);
    const result = f.run(ATTACH, ["publish", "7", "0.8.0", SHA, DEB.digest, f.digest]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no single native acceptance record");
    expect(result.stderr).toContain("has no verified native acceptance");
    expect(f.state().releases[0].draft).toBe(true);
    // Acceptance of other bytes does not count either.
    f.edit((st) => (st.releases[0].body += `\n\n${f.acceptMarker(900, "sha256:" + "8".repeat(64))}`));
    expect(f.run(ATTACH, ["publish", "7", "0.8.0", SHA, DEB.digest, f.digest]).stderr).toContain(
      "has no verified native acceptance",
    );
  });

  it("refuses to publish an arm64 installer that is not the recorded one", () => {
    const f = setup();
    expect(f.attachBoth().status).toBe(0);
    expect(f.accept().status).toBe(0);
    f.edit(
      (st) =>
        (st.releases[0].assets.find((a) => a.name.endsWith("-win-arm64.exe")).digest = "sha256:" + "7".repeat(64)),
    );
    const result = f.run(ATTACH, ["publish", "7", "0.8.0", SHA, DEB.digest, f.digest]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not the one its signing run recorded");
    expect(f.state().releases[0].draft).toBe(true);
  });

  it("starts a draft with no record from the newest qualifying run", () => {
    const f = setup({
      artifacts: { 300: [artifact(OTHER)], 200: [artifact(SHA, true)], 100: [artifact()] },
      signedRuns: [300, 200, 100],
    });
    expect(f.run(ATTACH, ["reconcile"]).status).toBe(0);
    expect(f.writes()).toEqual([dispatchAttach(100)]);
  });

  it("leaves an installer attached without a record alone", () => {
    const f = setup({ releases: [draft({ assets: [DEB, { name: "ORCA-0.8.0-win-x64.exe", digest: "sha256:0" }] })] });
    const result = f.run(ATTACH, ["reconcile"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("without a signing record");
    expect(f.writes()).toEqual([]);
  });

  it("reconciles only finals, and waits while no signed run qualifies", () => {
    const f = setup({
      releases: [
        draft({ id: 1, prerelease: true }),
        draft({ id: 2, name: "v0.8.0-rc.1" }),
        draft({ id: 3, target_commitish: OTHER, name: "v0.9.0" }),
      ],
    });
    const result = f.run(ATTACH, ["reconcile"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("v0.9.0 (release 3): no qualifying signed run");
    expect(f.writes()).toEqual([]);
  });

  const accepted = (f) => ["publish", "7", "0.8.0", SHA, DEB.digest, f.digest];

  it.each([
    ["no installer", () => {}, "is not the accepted installer"],
    ["no record", (st) => (st.releases[0].body = "Notes."), "no single signing record"],
  ])("refuses to publish a draft with %s", (_label, change, message) => {
    const f = setup();
    f.edit((st) => {
      st.releases[0].body = `Notes.\n\n<!-- orca-signed-run: 100 sha256:${"a".repeat(64)} -->`;
      change(st);
    });
    const result = f.run(ATTACH, accepted(f));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(f.writes()).toEqual([]);
  });

  it.each([
    [
      "changed Ubuntu bytes",
      (st) => (st.releases[0].assets[0].digest = "sha256:" + "9".repeat(64)),
      "not exactly the accepted",
    ],
    ["another source commit", (st) => (st.releases[0].target_commitish = OTHER), "no longer targets"],
    [
      "an extra asset",
      (st) => st.releases[0].assets.push({ name: "notes.txt", digest: "sha256:0" }),
      "unexpected assets",
    ],
    [
      "an older version than Latest",
      (st) => {
        st.releases.push({ ...draft({ id: 5, tag_name: "v0.9.0", name: "v0.9.0", draft: false }) });
        st.latest = 5;
      },
      "not newer than the current latest v0.9.0",
    ],
    [
      "the same version as Latest",
      (st) => {
        st.releases.push({ ...draft({ id: 5, tag_name: "v0.8.0", name: "v0.8.0", draft: false }) });
        st.latest = 5;
      },
      "not newer than the current latest v0.8.0",
    ],
    ["the tag at another commit", (st) => (st.tags["v0.8.0"] = OTHER), "already exists at"],
  ])("refuses to publish with %s", (_label, change, message) => {
    const f = setup();
    expect(f.attach().status).toBe(0);
    expect(f.x64Only().status).toBe(0);
    f.edit(change);
    const result = f.run(ATTACH, accepted(f));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(f.writes()).toHaveLength(3);
    expect(f.state().releases.find((r) => r.id === 7).draft).toBe(true);
  });

  it.each([["releases/latest"], ["git/ref/tags/"]])("stops before writing when %s cannot be read", (path) => {
    const f = setup();
    expect(f.attach().status).toBe(0);
    expect(f.x64Only().status).toBe(0);
    const result = f.run(ATTACH, accepted(f), { FAKE_ERROR_PATH: `^${path}` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("nothing written");
    expect(f.writes()).toHaveLength(3);
    expect(f.state().releases[0].draft).toBe(true);
  });

  it("publishes the first release when there is no Latest and no tag yet", () => {
    const f = setup();
    expect(f.attach().status).toBe(0);
    expect(f.x64Only().status).toBe(0);
    const result = f.run(ATTACH, accepted(f));
    expect(result.status, result.stderr).toBe(0);
    expect(f.state().latest).toBe(7);
  });

  it("refuses digests other than the accepted ones", () => {
    const f = setup();
    expect(f.attach().status).toBe(0);
    expect(f.x64Only().status).toBe(0);
    const result = f.run(ATTACH, ["publish", "7", "0.8.0", SHA, "sha256:" + "9".repeat(64), f.digest]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not exactly the accepted");
    expect(f.writes()).toHaveLength(3);
  });

  it("publishes over an older Latest and reads the accepted digests back", () => {
    const f = setup();
    expect(f.attach().status).toBe(0);
    expect(f.x64Only().status).toBe(0);
    f.edit((st) => {
      st.releases.push({ ...draft({ id: 5, tag_name: "v0.7.9", name: "v0.7.9", draft: false }) });
      st.latest = 5;
    });
    const result = f.run(ATTACH, accepted(f));
    expect(result.status, result.stderr).toBe(0);
    expect(f.state().latest).toBe(7);
    expect(f.state().tags["v0.8.0"]).toBe(SHA);
  });

  const publish = (f) => f.run(ATTACH, ["publish", "7", "0.8.0", SHA, DEB.digest, f.digest]);

  it.each([
    ["a run of another workflow", { run: { path: ".github/workflows/ci.yml" } }, "is not a successful"],
    ["a failed run", { run: { conclusion: "failure" } }, "is not a successful"],
    ["a run on another branch", { run: { head_branch: "topic" } }, "is not a successful"],
    ["evidence for another release", { evidence: { release_id: "8" } }, "release_id"],
    ["evidence for another commit", { evidence: { source_sha: OTHER } }, "source_sha"],
    ["evidence for other bytes", { evidence: { digest: "sha256:" + "8".repeat(64) } }, "digest"],
    ["evidence from another run", { evidence: { run_id: "901" } }, "run_id"],
    ["an upgrade claimed without a prior arm64 release", { evidence: { mode: "upgrade" } }, "mode"],
  ])("refuses to publish arm64 accepted by %s", (_label, over, message) => {
    const f = setup();
    expect(f.attachBoth().status).toBe(0);
    expect(f.accepted({}, over).status).toBe(0);
    const result = publish(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("has no verified native acceptance");
    expect(f.state().releases[0].draft).toBe(true);
  });

  it("refuses to publish arm64 whose acceptance run left no evidence", () => {
    const f = setup();
    expect(f.attachBoth().status).toBe(0);
    expect(f.accepted().status).toBe(0);
    f.edit((st) => (st.evidence = {}));
    expect(publish(f).stderr).toContain("no arm64-acceptance-evidence artifact");
  });

  it("requires the evidence's baseline to be the newest prior release with verified arm64 acceptance", () => {
    const prior = (id, version, digest, body) => ({
      ...draft({
        id,
        tag_name: `v${version}`,
        name: `v${version}`,
        draft: false,
        published_at: "2026-11-01T00:00:00Z",
        body: body ?? `<!-- orca-signed-run-arm64: 700 ${digest} -->\n<!-- orca-arm64-accepted: 800 ${digest} -->`,
      }),
      assets: [{ id: id * 10, name: `ORCA-${version}-win-arm64.exe`, digest }],
    });
    const OLD = "sha256:" + "1".repeat(64);
    const NEWER = "sha256:" + "2".repeat(64);
    const priorRun = {
      ...goodRun,
      id: 800,
      path: ".github/workflows/release-accept-arm64.yml",
      event: "workflow_run",
    };
    const setupPrior = (extra = [], run800 = priorRun) => {
      const f = setup();
      f.edit((st) => {
        st.releases.push(
          prior(3, "0.7.2", OLD),
          prior(4, "0.7.10", NEWER),
          prior(5, "0.9.0", OLD),
          prior(6, "0.7.11-rc.1", OLD),
          ...extra,
        );
        st.runs["800"] = run800;
        // The receipt job run 800 left for each prior release it accepted.
        st.jobs = {
          ...st.jobs,
          800: st.releases
            .filter((r) => r.draft === false)
            .map((r) => ({
              name: `arm64 acceptance receipt: release ${r.id} ${r.tag_name} ${r.target_commitish} ${r.assets[0].digest}`,
              status: "completed",
              conclusion: "success",
            })),
        };
      });
      expect(f.attachBoth().status).toBe(0);
      return f;
    };
    const upgradeFrom = (version, digest) => ({ evidence: { mode: "upgrade", previous: { version, digest } } });
    const fresh = setupPrior();
    expect(fresh.accepted().status).toBe(0);
    expect(publish(fresh).stderr).toContain('mode "fresh", not "upgrade"');
    const stale = setupPrior();
    expect(stale.accepted({}, upgradeFrom("0.7.2", OLD)).status).toBe(0);
    expect(publish(stale).stderr).toContain("previous");
    const right = setupPrior();
    expect(right.accepted({}, upgradeFrom("0.7.10", NEWER)).status).toBe(0);
    const published = publish(right);
    expect(published.status, published.stderr).toBe(0);
    // A newer release marked x64-only is never the baseline.
    const declined = setupPrior([prior(8, "0.7.12", OLD, "<!-- orca-x64-only -->")]);
    expect(declined.accepted({}, upgradeFrom("0.7.10", NEWER)).status).toBe(0);
    expect(publish(declined).status, publish(declined).stderr).toBe(0);
    // A newer arm64 release without acceptance proof stops publication; it is not skipped.
    const unproven = setupPrior([prior(8, "0.7.12", OLD, `<!-- orca-signed-run-arm64: 700 ${OLD} -->`)]);
    expect(unproven.accepted({}, upgradeFrom("0.7.10", NEWER)).status).toBe(0);
    expect(publish(unproven).stderr).toContain("upgrade baseline v0.7.12 has no verified arm64 acceptance");
    // So does a baseline whose acceptance run did not succeed on main.
    const failedRun = setupPrior([], { ...priorRun, conclusion: "failure" });
    expect(failedRun.accepted({}, upgradeFrom("0.7.10", NEWER)).status).toBe(0);
    expect(publish(failedRun).stderr).toContain("upgrade baseline v0.7.10 has no verified arm64 acceptance");
    // And a baseline whose acceptance run left no receipt for that release's installer.
    const noReceipt = setupPrior();
    noReceipt.edit((st) => (st.jobs = { 800: [] }));
    expect(noReceipt.accepted({}, upgradeFrom("0.7.10", NEWER)).status).toBe(0);
    expect(publish(noReceipt).stderr).toMatch(
      /upgrade baseline v0\.7\.10 has no verified arm64 acceptance: .*no successful job/,
    );
  });

  it("refuses to publish without arm64 unless x64-only was decided", () => {
    const f = setup();
    expect(f.attach().status).toBe(0);
    const result = publish(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no x64-only decision");
  });

  it("keeps an x64-only decision: removes arm64, and attach, reconcile and accept leave it out", () => {
    const f = setup();
    expect(f.attachBoth().status).toBe(0);
    const decided = f.x64Only();
    expect(decided.status, decided.stderr).toBe(0);
    const r = f.state().releases[0];
    expect(r.assets.map((a) => a.name)).toEqual([DEB.name, ...serverNames(), "ORCA-0.8.0-win-x64.exe"]);
    expect(r.body).toContain("<!-- orca-x64-only -->");
    const before = f.writes().length;
    expect(f.x64Only().status).toBe(0);
    expect(f.writes()).toHaveLength(before);
    // Reconcile sees nothing missing; a rerun of the attach does not bring arm64 back.
    expect(f.run(ATTACH, ["reconcile"]).status).toBe(0);
    expect(f.attachBoth().status).toBe(0);
    expect(f.writes()).toHaveLength(before);
    expect(f.state().releases[0].assets).toHaveLength(5);
    expect(f.run(ATTACH, ["accept-select"]).stdout).toBe("");
    expect(f.accept().stderr).toContain("marked x64-only");
    const published = publish(f);
    expect(published.status, published.stderr).toBe(0);
    expect(f.state().releases[0].draft).toBe(false);
  });

  it("refuses to publish an x64-only draft that still has arm64", () => {
    const f = setup();
    expect(f.attachBoth().status).toBe(0);
    f.edit((st) => (st.releases[0].body += "\n\n<!-- orca-x64-only -->"));
    expect(publish(f).stderr).toContain("marked x64-only but still has");
  });
  describe("the signed server bundle (#876)", () => {
    const RC = "0.8.0-rc.1";
    const bundleDir = (version = "0.8.0", tag = "bundle") => {
      const dir = mkdtempSync(join(tmpdir(), "orca-server-files-"));
      dirs.push(dir);
      const files = serverFiles(version, SHA, tag);
      for (const file of files) writeFileSync(join(dir, file.name), file.content);
      return { dir, digests: files.map((a) => a.digest), record: (run) => serverRecord(run, files) };
    };
    const bare = (over = {}) => draft({ body: "Notes.", assets: [DEB], ...over });
    const prerelease = (over = {}) =>
      draft({
        id: 9,
        name: `v${RC}`,
        tag_name: `v${RC}`,
        draft: false,
        prerelease: true,
        body: "Notes.",
        assets: [],
        ...over,
      });
    const ready = (f) => {
      expect(f.attachBoth().status).toBe(0);
      f.accepted();
    };
    const publishFinal = (f) => f.run(ATTACH, ["publish", "7", "0.8.0", SHA, DEB.digest, f.digest]);

    it("prints the digests and the receipt for exactly the files it is given", () => {
      const f = setup();
      const b = bundleDir();
      const result = f.run(ATTACH, ["server-receipt", "7", SHA, "0.8.0", b.dir]);
      expect(result.status, result.stderr).toBe(0);
      const receipt = serverReceipt(7, "0.8.0", SHA, serverFiles()).split(" ").at(-1);
      expect(result.stdout).toBe(`digests=${b.digests.join(" ")}\nreceipt=${receipt}\n`);
    });

    it("targets the one final draft or published prerelease at a commit on main", () => {
      const f = setup({ releases: [bare(), prerelease()] });
      f.edit((st) => {
        st.onMain = [SHA];
        st.tags[`v${RC}`] = SHA;
      });
      const final = f.run(ATTACH, ["server-target", "0.8.0", SHA]);
      expect(final.status, final.stderr).toBe(0);
      expect(final.stdout).toBe("id=7\nkind=final\n");
      const rc = f.run(ATTACH, ["server-target", RC, SHA]);
      expect(rc.status, rc.stderr).toBe(0);
      expect(rc.stdout).toBe("id=9\nkind=prerelease\n");
    });

    it.each([
      ["a commit not on main", () => {}, "is not on main"],
      ["no release of that name", (st) => (st.releases = []), "0 releases are named"],
      ["a release at another commit", (st) => (st.releases[0].target_commitish = OTHER), "no longer targets"],
      ["a published final", (st) => (st.releases[0].draft = false), "no longer a final draft"],
    ])("refuses to build for %s", (_label, change, message) => {
      const f = setup({ releases: [bare()] });
      f.edit((st) => {
        if (!message.includes("on main")) st.onMain = [SHA];
        change(st);
      });
      const result = f.run(ATTACH, ["server-target", "0.8.0", SHA]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.stdout).toBe("");
    });

    it("uploads the three files, then records them; a rerun writes nothing", () => {
      const f = setup({ releases: [bare()] });
      const b = bundleDir();
      const first = f.run(ATTACH, ["server-attach", "7", SHA, "0.8.0", "321", b.dir]);
      expect(first.status, first.stderr).toBe(0);
      const r = f.state().releases[0];
      expect(r.assets.map((a) => a.digest)).toEqual([DEB.digest, ...b.digests]);
      expect(r.body).toBe(`Notes.\n\n${b.record(321)}`);
      expect(f.writes()).toEqual([...serverNames().map((n) => ["upload", "7", n]), RECORD]);
      expect(f.run(ATTACH, ["server-attach", "7", SHA, "0.8.0", "321", b.dir]).status).toBe(0);
      expect(f.writes()).toHaveLength(4);
    });

    it("attaches to a published prerelease whose tag is at the commit", () => {
      const f = setup({ releases: [prerelease()] });
      f.edit((st) => (st.tags[`v${RC}`] = SHA));
      const b = bundleDir(RC);
      const result = f.run(ATTACH, ["server-attach", "9", SHA, RC, "322", b.dir]);
      expect(result.status, result.stderr).toBe(0);
      expect(f.state().releases[0].assets.map((a) => a.digest)).toEqual(b.digests);
      expect(f.state().releases[0].body).toContain(b.record(322));
    });

    it("replaces only an unrecorded partial set, never a recorded bundle", () => {
      const partial = { id: 950, name: serverNames()[0], digest: "sha256:" + "9".repeat(64) };
      const f = setup({ releases: [bare({ assets: [DEB, partial] })] });
      const b = bundleDir();
      const result = f.run(ATTACH, ["server-attach", "7", SHA, "0.8.0", "323", b.dir]);
      expect(result.status, result.stderr).toBe(0);
      expect(f.writes()[0]).toEqual(["delete", "950"]);
      expect(f.state().releases[0].assets.map((a) => a.digest)).toEqual([DEB.digest, ...b.digests]);

      const other = bundleDir("0.8.0", "other bytes");
      const again = f.run(ATTACH, ["server-attach", "7", SHA, "0.8.0", "324", other.dir]);
      expect(again.status).not.toBe(0);
      expect(again.stderr).toContain("already records another server bundle");
      expect(f.state().releases[0].assets.map((a) => a.digest)).toEqual([DEB.digest, ...b.digests]);
    });

    it.each([
      ["two records", `Notes.\n\n${serverRecord(55)}\n\n${serverRecord(56)}`],
      ["a malformed record", "Notes.\n\n<!-- orca-server-run: 55 sha256:short -->"],
    ])("touches nothing on a release with %s", (_label, body) => {
      const f = setup({ releases: [bare({ body, assets: [DEB, SERVER[0]] })] });
      const b = bundleDir();
      const result = f.run(ATTACH, ["server-attach", "7", SHA, "0.8.0", "325", b.dir]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("more than one or a malformed server bundle record");
      expect(f.writes()).toEqual([]);
      const reconcile = f.run(ATTACH, ["server-reconcile"]);
      expect(reconcile.stderr).toContain("fix by hand");
      expect(f.writes()).toEqual([]);
    });

    it("writes nothing to a release published between selection and the first write", () => {
      const f = setup({ releases: [bare()] });
      const b = bundleDir();
      const result = f.run(ATTACH, ["server-attach", "7", SHA, "0.8.0", "326", b.dir], { FAKE_PUBLISH_AT_READ: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no longer a final draft");
      expect(f.writes()).toEqual([]);
    });

    it("publishes with arm64, or x64-only, plus the server bundle's receipt", () => {
      const both = setup();
      ready(both);
      const published = publishFinal(both);
      expect(published.status, published.stderr).toBe(0);
      expect(both.state().releases[0].assets).toHaveLength(6);

      const x64 = setup();
      expect(x64.attachBoth().status).toBe(0);
      expect(x64.x64Only().status).toBe(0);
      const alone = publishFinal(x64);
      expect(alone.status, alone.stderr).toBe(0);
      expect(x64.state().releases[0].assets).toHaveLength(5);
    });

    it.each([
      [
        "no server bundle",
        (st) =>
          Object.assign(st.releases[0], {
            body: st.releases[0].body.replace(SERVER_RECORD, ""),
            assets: st.releases[0].assets.filter((a) => !a.name.startsWith("orca-server-")),
          }),
        "and the server bundle",
      ],
      [
        "files but no record",
        (st) => (st.releases[0].body = st.releases[0].body.replace(SERVER_RECORD, "")),
        "has no server bundle record",
      ],
      ["two records", (st) => (st.releases[0].body += `\n\n${serverRecord(56)}`), "more than one or a malformed"],
      [
        "a file that differs from its record",
        (st) => (st.releases[0].assets.find((a) => a.name.endsWith(".tar.xz")).digest = "sha256:" + "8".repeat(64)),
        "do not match their record",
      ],
      [
        "a manifest for another commit",
        (st) => {
          const files = serverFiles("0.8.0", OTHER);
          st.releases[0].assets = [
            ...st.releases[0].assets.filter((a) => !a.name.startsWith("orca-server-")),
            ...files,
          ];
          st.releases[0].body = st.releases[0].body.replace(SERVER_RECORD, serverRecord(55, files));
        },
        "is not for v0.8.0 at",
      ],
      [
        "a run for another commit",
        (st) => (st.runs["55"].display_title = `Release (server bundle) v0.8.0 at ${OTHER}`),
        "is not a successful Release (server bundle) dispatch",
      ],
      [
        "a run dispatched from a branch",
        (st) => (st.runs["55"].head_branch = "topic"),
        "is not a successful Release (server bundle) dispatch",
      ],
      [
        "a failed run",
        (st) => (st.runs["55"].conclusion = "failure"),
        "is not a successful Release (server bundle) dispatch",
      ],
      [
        "a run whose clean-host check did not pass",
        (st) => (st.jobs["55"][1].conclusion = "skipped"),
        "no successful 'stage --bundle on a clean host' job",
      ],
      ["an unknown run", (st) => delete st.runs["55"], "cannot be read"],
      [
        "a receipt for another release",
        (st) => (st.jobs["55"][2].name = serverReceipt(8)),
        "has no successful 'server bundle receipt: release 7",
      ],
      [
        "a receipt for other bytes",
        (st) => (st.jobs["55"][2].name = serverReceipt(7, "0.8.0", SHA, serverFiles("0.8.0", SHA, "other"))),
        "has no successful 'server bundle receipt: release 7",
      ],
      [
        "a receipt job that did not pass",
        (st) => (st.jobs["55"][2].conclusion = "failure"),
        "has no successful 'server bundle receipt: release 7",
      ],
    ])("refuses to publish a final with %s", (_label, change, message) => {
      const f = setup();
      ready(f);
      f.edit(change);
      const result = publishFinal(f);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(f.state().releases[0].draft).toBe(true);
    });

    describe("before the 0.8 line (0.7.1 keeps its approved desktop asset set)", () => {
      const V = "0.7.1";
      const deb = { id: 61, name: `ORCA-${V}-linux-amd64.deb`, digest: "sha256:" + "d".repeat(64) };
      const exe = { id: 62, name: `ORCA-${V}-win-x64.exe`, digest: "sha256:" + "e".repeat(64) };
      const final = (over = {}) =>
        draft({
          id: 71,
          name: `v${V}`,
          tag_name: `v${V}`,
          body: `Notes.\n\n<!-- orca-signed-run: 100 ${exe.digest} -->\n\n<!-- orca-x64-only -->`,
          assets: [deb, exe],
          ...over,
        });

      it("publishes with the installers alone: no server bundle, record or receipt", () => {
        const f = setup({ releases: [final()] });
        const result = f.run(ATTACH, ["publish", "71", V, SHA, deb.digest, exe.digest]);
        expect(result.status, result.stderr).toBe(0);
        expect(f.state().releases[0].draft).toBe(false);
        expect(f.state().releases[0].assets).toHaveLength(2);
      });

      it("treats server files on it as unexpected, and never builds, attaches or reconciles one", () => {
        const f = setup({ releases: [final({ assets: [deb, exe, ...serverFiles(V)] })] });
        f.edit((st) => (st.onMain = [SHA]));
        const result = f.run(ATTACH, ["publish", "71", V, SHA, deb.digest, exe.digest]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unexpected assets");
        expect(f.run(ATTACH, ["server-target", V, SHA]).stderr).toContain("before the server bundle's 0.8.0 line");
        const b = bundleDir(V);
        expect(f.run(ATTACH, ["server-attach", "71", SHA, V, "330", b.dir]).stderr).toContain(
          "before the server bundle's 0.8.0 line",
        );
        f.edit((st) => (st.releases = [final({ assets: [deb, exe] })]));
        expect(f.run(ATTACH, ["server-reconcile"]).status).toBe(0);
        expect(f.writes()).toEqual([]);
      });

      it("starts the bundle with the 0.8.0 release candidates", () => {
        const f = setup({
          releases: [bare({ id: 72, name: "v0.8.0-rc.1", tag_name: "v0.8.0-rc.1", draft: false, prerelease: true })],
        });
        f.edit((st) => (st.tags["v0.8.0-rc.1"] = SHA));
        expect(f.run(ATTACH, ["server-reconcile"]).status).toBe(0);
        expect(f.writes()).toHaveLength(1);
      });
    });

    it("reconciles only unrecorded releases on a version line newer than Latest", () => {
      const f = setup({
        releases: [
          bare(),
          prerelease(),
          prerelease({ id: 10, name: "v0.7.0-rc.2", tag_name: "v0.7.0-rc.2" }),
          draft({ id: 11, name: "v0.9.0", tag_name: "v0.9.0", target_commitish: OTHER }),
          draft({ id: 5, name: "v0.7.0", tag_name: "v0.7.0", draft: false, body: "Notes.", assets: [] }),
        ],
      });
      f.edit((st) => (st.latest = 5));
      const result = f.run(ATTACH, ["server-reconcile"]);
      expect(result.status, result.stderr).toBe(0);
      const dispatch = (version, sha) => [
        "workflow",
        "run",
        "release-server-bundle.yml",
        "--repo",
        "o/r",
        "--ref",
        "main",
        "-f",
        `version=${version}`,
        "-f",
        `source_sha=${sha}`,
      ];
      expect(f.writes()).toEqual([dispatch("0.8.0", SHA), dispatch(RC, SHA)]);
    });
  });
});
