/** feed-arches.js (#889): arm64 is published and fed only with verified native acceptance. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acceptanceProblem, baseline, feedArches } from "../deploy/feed-arches.js";

const ARM = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const X64 = `sha256:${"c".repeat(64)}`;
const SHA = "d".repeat(40);
const REPO = "o/r";
const signed = (digest, run = 7) => `<!-- orca-signed-run-arm64: ${run} ${digest} -->`;
const accepted = (digest, run = 9) => `<!-- orca-arm64-accepted: ${run} ${digest} -->`;

function release({ arm = ARM, body = [signed(ARM), accepted(ARM)], version = "0.7.1" } = {}) {
  const assets = [
    { id: 1, name: `ORCA-${version}-linux-amd64.deb`, digest: OTHER },
    { id: 2, name: `ORCA-${version}-win-x64.exe`, digest: X64 },
  ];
  if (arm !== null) assets.push({ id: 3, name: `ORCA-${version}-win-arm64.exe`, digest: arm });
  return {
    id: 42,
    tag_name: `v${version}`,
    target_commitish: SHA,
    draft: false,
    prerelease: false,
    published_at: "2026-11-30T00:00:00Z",
    assets,
    body: [`notes`, `<!-- orca-signed-run: 7 ${X64} -->`, ...body].join("\n\n"),
  };
}
const run = (over = {}) => ({
  id: 9,
  path: ".github/workflows/release-accept-arm64.yml",
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  head_branch: "main",
  event: "workflow_run",
  status: "completed",
  conclusion: "success",
  ...over,
});
const evidence = (over = {}) => ({
  format: 1,
  run_id: "9",
  release_id: "42",
  version: "0.7.1",
  source_sha: SHA,
  digest: ARM,
  mode: "fresh",
  previous: null,
  ...over,
});
const input = (over = {}) => ({
  version: "0.7.1",
  repo: REPO,
  release: release(),
  releases: [],
  run: run(),
  evidence: evidence(),
  ...over,
});
const published = (version, digest, over = {}) => ({
  ...release({ version, arm: digest, body: [] }),
  id: Number(version.replace(/\D/g, "")),
  ...over,
});

describe("baseline", () => {
  it("is the newest published final older than the version with an arm64 installer", () => {
    const releases = [
      published("0.7.1", OTHER),
      published("0.7.0", null),
      published("0.6.9", X64),
      published("0.6.10", ARM),
      published("0.6.11", ARM, { prerelease: true }),
      published("0.6.12", ARM, { draft: true }),
      { ...published("0.6.13", ARM), tag_name: "v0.6.13-rc.1" },
    ];
    expect(baseline("0.7.1", releases)).toEqual({ version: "0.6.10", digest: ARM, asset: 3 });
    expect(baseline("0.6.10", releases)).toEqual({ version: "0.6.9", digest: X64, asset: 3 });
    expect(baseline("0.6.9", releases)).toBeNull();
  });
});

describe("acceptanceProblem", () => {
  it("accepts a fresh install with no prior arm64 release", () => {
    expect(acceptanceProblem(input())).toBeUndefined();
  });

  it("accepts an upgrade over exactly the baseline", () => {
    const releases = [published("0.7.0", OTHER)];
    const upgrade = evidence({ mode: "upgrade", previous: { version: "0.7.0", digest: OTHER } });
    expect(acceptanceProblem(input({ releases, evidence: upgrade }))).toBeUndefined();
    expect(acceptanceProblem(input({ releases }))).toMatch(/mode "fresh", not "upgrade"/);
  });

  it.each([
    ["no acceptance record", { release: release({ body: [signed(ARM)] }) }, /native acceptance record/],
    ["acceptance of other bytes", { release: release({ body: [signed(ARM), accepted(OTHER)] }) }, /native acceptance/],
    [
      "two acceptance records",
      { release: release({ body: [signed(ARM), accepted(ARM), accepted(ARM, 10)] }) },
      /native acceptance/,
    ],
    ["no signing record", { release: release({ body: [accepted(ARM)] }) }, /signing record/],
    ["an unreadable run", { run: undefined }, /could not be read/],
    ["another run id", { run: run({ id: 10 }) }, /could not be read/],
    ["another workflow", { run: run({ path: ".github/workflows/ci.yml" }) }, /not a successful/],
    ["a failed run", { run: run({ conclusion: "failure" }) }, /not a successful/],
    ["a fork's run", { run: run({ head_repository: { full_name: "fork/r" } }) }, /not a successful/],
    ["a push run", { run: run({ event: "push" }) }, /not a successful/],
    ["no evidence", { evidence: undefined }, /no arm64-acceptance-evidence/],
    ["evidence of another release", { evidence: evidence({ release_id: "41" }) }, /release_id/],
    ["evidence of another version", { evidence: evidence({ version: "0.7.2" }) }, /version/],
    ["evidence of another commit", { evidence: evidence({ source_sha: "e".repeat(40) }) }, /source_sha/],
    ["evidence of other bytes", { evidence: evidence({ digest: OTHER }) }, /digest/],
    [
      "an x64-only decision",
      { release: release({ body: [signed(ARM), accepted(ARM), "<!-- orca-x64-only -->"] }) },
      /x64-only/,
    ],
  ])("refuses %s", (_label, over, problem) => {
    expect(acceptanceProblem(input(over))).toMatch(problem);
  });
});

describe("feedArches", () => {
  it("serves arm64 beside x64 when acceptance verifies", () => {
    expect(feedArches(input())).toEqual({ arches: ["x64", "arm64"] });
  });

  it.each([
    [
      "no arm64 installer (every release before #889)",
      { release: release({ arm: null, body: [] }) },
      /has no ORCA-0.7.1-win-arm64.exe/,
    ],
    ["an x64-only decision", { release: release({ body: ["<!-- orca-x64-only -->"] }) }, /x64-only/],
    ["a prerelease", { version: "0.7.1-rc.1" }, /prerelease/],
  ])("serves x64 alone with %s", (_label, over, reason) => {
    const result = feedArches(input(over));
    expect(result.arches).toEqual(["x64"]);
    expect(result.reason).toMatch(reason);
  });

  it("fails rather than feed x64 alone when attached arm64 does not verify", () => {
    expect(feedArches(input({ evidence: undefined })).error).toMatch(/no arm64-acceptance-evidence/);
  });
});

describe("command line", () => {
  it("prints the baseline, the acceptance run and the served list; serve fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-arches-"));
    const write = (name, value) => {
      writeFileSync(join(dir, name), JSON.stringify(value));
      return join(dir, name);
    };
    const cli = (...args) =>
      spawnSync(process.execPath, ["tools/deploy/feed-arches.js", ...args], { encoding: "utf8" });
    try {
      const rel = write("release.json", release());
      const none = write("releases.json", []);
      const runFile = write("run.json", run());
      const ev = write("evidence.json", evidence());
      expect(cli("baseline", "0.7.1", write("prior.json", [published("0.7.0", OTHER)])).stdout).toBe(
        `0.7.0 ${OTHER} 3\n`,
      );
      expect(cli("baseline", "0.7.1", none).stdout).toBe("");
      expect(cli("acceptance-run", "0.7.1", rel).stdout).toBe("9\n");
      expect(cli("verify", "0.7.1", REPO, rel, none, runFile, ev).status).toBe(0);
      const missing = cli("verify", "0.7.1", REPO, rel, none, runFile, join(dir, "absent.json"));
      expect([missing.status, missing.stderr]).toEqual([1, expect.stringContaining("no arm64-acceptance-evidence")]);
      expect(cli("serve", "0.7.1", REPO, rel, none, runFile, ev).stdout).toBe("x64 arm64\n");
      const old = write("old.json", release({ arm: null, body: [] }));
      const x64 = cli("serve", "0.7.1", REPO, old, none);
      expect([x64.status, x64.stdout]).toEqual([0, "x64\n"]);
      expect(x64.stderr).toMatch(/^arm64 not served: /);
      expect(cli("serve", "0.7.1", REPO, rel, none, runFile, join(dir, "absent.json")).status).toBe(1);
      expect(cli("serve", "v0.7.1", REPO, rel, none).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
