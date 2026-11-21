/** feed-auto.js: start the feed only for a published release and its one successful signed run. */
import { describe, expect, it } from "vitest";
import { fromRelease, fromSignedRun } from "../deploy/feed-auto.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const signedRun = (id, extra = {}) => ({
  id,
  path: ".github/workflows/windows-signed.yml",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  ...extra,
});
const artifact = (sha, expired = false) => ({ name: `windows-signed-${sha}`, expired });
const published = (tag) => ({ tag_name: tag, draft: false, published_at: "2026-11-21T22:11:55Z" });

describe("fromRelease", () => {
  it("dispatches the one signing run that holds the tagged commit's live artifact", () => {
    const result = fromRelease({
      release: published("v0.7.1"),
      sha: SHA,
      runs: [signedRun(1), signedRun(2), signedRun(3)],
      artifactsByRun: { 1: [artifact(OTHER)], 2: [artifact(SHA)], 3: [artifact(SHA, true)] },
    });
    expect(result).toEqual({ version: "0.7.1", runId: "2" });
  });

  it("waits for the signing run when none holds the commit yet", () => {
    const result = fromRelease({
      release: published("v0.7.1"),
      sha: SHA,
      runs: [signedRun(1)],
      artifactsByRun: { 1: [] },
    });
    expect(result.skip).toMatch(/its completion will feed v0\.7\.1/);
  });

  it("refuses to guess between several signing runs of the same commit", () => {
    expect(() =>
      fromRelease({
        release: published("v0.7.1"),
        sha: SHA,
        runs: [signedRun(1), signedRun(2)],
        artifactsByRun: { 1: [artifact(SHA)], 2: [artifact(SHA)] },
      }),
    ).toThrow(/several signing runs/);
  });

  it("ignores runs that failed, ran elsewhere or are not the signing workflow", () => {
    const result = fromRelease({
      release: published("v0.7.1"),
      sha: SHA,
      runs: [
        signedRun(1, { conclusion: "failure" }),
        signedRun(2, { head_branch: "feature" }),
        signedRun(3, { path: ".github/workflows/desktop.yml" }),
      ],
      artifactsByRun: { 1: [artifact(SHA)], 2: [artifact(SHA)], 3: [artifact(SHA)] },
    });
    expect(result.skip).toBeDefined();
  });

  it("skips drafts, non-version tags and unresolved tags", () => {
    expect(fromRelease({ release: { ...published("v0.7.1"), draft: true }, sha: SHA }).skip).toMatch(/not published/);
    expect(fromRelease({ release: published("nightly"), sha: SHA }).skip).toMatch(/not a version/);
    expect(fromRelease({ release: published("v0.7.1"), sha: "" }).skip).toMatch(/does not resolve/);
  });
});

describe("fromSignedRun", () => {
  it("dispatches when the signed commit's tag is a published release", () => {
    const result = fromSignedRun({
      run: signedRun(9),
      artifacts: [artifact(SHA), { name: "windows-signed-prepare-bundle", expired: false }],
      tagsAtSha: { [SHA]: ["v0.8.0-rc.1"] },
      releases: { "v0.8.0-rc.1": published("v0.8.0-rc.1") },
    });
    expect(result).toEqual({ version: "0.8.0-rc.1", runId: "9" });
  });

  it("waits when the tag has no published release yet", () => {
    const result = fromSignedRun({
      run: signedRun(9),
      artifacts: [artifact(SHA)],
      tagsAtSha: { [SHA]: ["v0.8.0"] },
      releases: { "v0.8.0": { tag_name: "v0.8.0", draft: true } },
    });
    expect(result.skip).toMatch(/publishing it will feed it/);
  });

  it("skips failed or off-main signing runs and runs with no signed artifact", () => {
    expect(fromSignedRun({ run: signedRun(9, { conclusion: "failure" }) }).skip).toBeDefined();
    expect(fromSignedRun({ run: signedRun(9, { head_branch: "x" }) }).skip).toBeDefined();
    expect(fromSignedRun({ run: signedRun(9), artifacts: [artifact(SHA, true)] }).skip).toMatch(
      /no single signed artifact/,
    );
  });

  it("refuses a commit with several published version tags", () => {
    expect(() =>
      fromSignedRun({
        run: signedRun(9),
        artifacts: [artifact(SHA)],
        tagsAtSha: { [SHA]: ["v0.8.0", "v0.8.1"] },
        releases: { "v0.8.0": published("v0.8.0"), "v0.8.1": published("v0.8.1") },
      }),
    ).toThrow(/several published releases/);
  });
});
