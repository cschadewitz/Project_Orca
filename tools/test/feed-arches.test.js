/** feed-arches.js (#889): arm64 is published and fed only with verified native acceptance. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acceptanceProblem, baseline, baselineRun, feedArches } from "../deploy/feed-arches.js";

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
// A published release whose arm64 installer passed acceptance in run 6.
const accepted06 = (version, digest, over = {}) =>
  published(version, digest, { body: [signed(digest, 5), accepted(digest, 6)].join("\n\n"), ...over });
const prior = run({ id: 6 });

describe("baseline", () => {
  it("is the newest published final older than the version with an accepted arm64 installer", () => {
    const releases = [
      accepted06("0.7.1", OTHER),
      published("0.7.0", null),
      accepted06("0.6.9", X64),
      accepted06("0.6.10", ARM),
      accepted06("0.6.11", ARM, { prerelease: true }),
      accepted06("0.6.12", ARM, { draft: true }),
      { ...accepted06("0.6.13", ARM), tag_name: "v0.6.13-rc.1" },
    ];
    expect(baselineRun("0.7.1", releases)).toBe("6");
    expect(baseline("0.7.1", releases, { repo: REPO, run: prior })).toEqual({
      version: "0.6.10",
      digest: ARM,
      asset: 3,
    });
    expect(baseline("0.6.10", releases, { repo: REPO, run: prior })).toEqual({
      version: "0.6.9",
      digest: X64,
      asset: 3,
    });
    expect(baseline("0.6.9", releases, { repo: REPO, run: prior })).toEqual({ none: true });
    expect(baselineRun("0.6.9", releases)).toBeUndefined();
  });

  it("skips releases marked x64-only", () => {
    const releases = [accepted06("0.6.9", X64), published("0.7.0", ARM, { body: "<!-- orca-x64-only -->" })];
    expect(baseline("0.7.1", releases, { repo: REPO, run: prior })).toEqual({
      version: "0.6.9",
      digest: X64,
      asset: 3,
    });
  });

  it.each([
    ["no acceptance record", published("0.7.0", ARM, { body: signed(ARM, 5) }), prior, /native acceptance record/],
    [
      "acceptance of other bytes",
      accepted06("0.7.0", ARM, { body: [signed(ARM, 5), accepted(OTHER, 6)].join("\n") }),
      prior,
      /native acceptance record/,
    ],
    ["no signing record", published("0.7.0", ARM, { body: accepted(ARM, 6) }), prior, /signing record/],
    ["an unreadable run", accepted06("0.7.0", ARM), undefined, /could not be read/],
    ["a failed run", accepted06("0.7.0", ARM), run({ id: 6, conclusion: "failure" }), /not a successful/],
    ["a run off main", accepted06("0.7.0", ARM), run({ id: 6, head_branch: "x" }), /not a successful/],
  ])("reports missing proof, not no baseline, for %s", (_label, candidate, baseRun, problem) => {
    // An older accepted release never stands in for the newest candidate.
    const result = baseline("0.7.1", [accepted06("0.6.9", X64), candidate], { repo: REPO, run: baseRun });
    expect(result.none).toBeUndefined();
    expect(result.problem).toMatch(/^upgrade baseline v0\.7\.0 has no verified arm64 acceptance: /);
    expect(result.problem).toMatch(problem);
  });
});

describe("acceptanceProblem", () => {
  it("accepts a fresh install with no prior arm64 release", () => {
    expect(acceptanceProblem(input())).toBeUndefined();
  });

  it("accepts an upgrade over exactly the baseline", () => {
    const releases = [accepted06("0.7.0", OTHER)];
    const upgrade = evidence({ mode: "upgrade", previous: { version: "0.7.0", digest: OTHER } });
    expect(acceptanceProblem(input({ releases, baselineRun: prior, evidence: upgrade }))).toBeUndefined();
    expect(acceptanceProblem(input({ releases, baselineRun: prior }))).toMatch(/mode "fresh", not "upgrade"/);
  });

  it("refuses when the upgrade baseline's own acceptance cannot be verified", () => {
    const releases = [accepted06("0.7.0", OTHER)];
    const upgrade = evidence({ mode: "upgrade", previous: { version: "0.7.0", digest: OTHER } });
    expect(acceptanceProblem(input({ releases, evidence: upgrade }))).toMatch(
      /upgrade baseline v0\.7\.0 has no verified arm64 acceptance: acceptance run 6 could not be read/,
    );
    const unaccepted = [published("0.7.0", OTHER, { body: signed(OTHER, 5) })];
    expect(acceptanceProblem(input({ releases: unaccepted, baselineRun: prior }))).toMatch(
      /upgrade baseline v0\.7\.0 has no verified arm64 acceptance/,
    );
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
      const priors = write("prior.json", [accepted06("0.7.0", OTHER)]);
      const priorRun = write("prior-run.json", prior);
      const absent = join(dir, "absent.json");
      expect(cli("baseline-run", "0.7.1", priors).stdout).toBe("6\n");
      expect(cli("baseline-run", "0.7.1", none).stdout).toBe("");
      expect(cli("baseline", "0.7.1", REPO, priors, priorRun).stdout).toBe(`0.7.0 ${OTHER} 3\n`);
      const unproven = cli("baseline", "0.7.1", REPO, priors, absent);
      expect([unproven.status, unproven.stdout]).toEqual([1, ""]);
      expect(unproven.stderr).toMatch(/upgrade baseline v0\.7\.0 has no verified arm64 acceptance/);
      expect(cli("baseline", "0.7.1", REPO, none, "-").stdout).toBe("");
      expect(cli("acceptance-run", "0.7.1", rel).stdout).toBe("9\n");
      expect(cli("verify", "0.7.1", REPO, rel, none, "-", runFile, ev).status).toBe(0);
      const missing = cli("verify", "0.7.1", REPO, rel, none, "-", runFile, absent);
      expect([missing.status, missing.stderr]).toEqual([1, expect.stringContaining("no arm64-acceptance-evidence")]);
      expect(cli("serve", "0.7.1", REPO, rel, none, "-", runFile, ev).stdout).toBe("x64 arm64\n");
      const old = write("old.json", release({ arm: null, body: [] }));
      const x64 = cli("serve", "0.7.1", REPO, old, none);
      expect([x64.status, x64.stdout]).toEqual([0, "x64\n"]);
      expect(x64.stderr).toMatch(/^arm64 not served: /);
      expect(cli("serve", "0.7.1", REPO, rel, none, "-", runFile, absent).status).toBe(1);
      expect(cli("serve", "v0.7.1", REPO, rel, none).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
