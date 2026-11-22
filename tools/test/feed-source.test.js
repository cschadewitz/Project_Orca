/** feed-source.js: only a published release's signed run, from main, may feed a version. */
import { describe, expect, it } from "vitest";
import { checkSource } from "../deploy/feed-source.js";

const SHA = "a".repeat(40);
const ok = () => ({
  version: "0.7.1",
  sha: SHA,
  run: {
    path: ".github/workflows/windows-signed.yml",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  },
  release: { tag_name: "v0.7.1", draft: false, published_at: "2026-11-20T00:00:00Z" },
});

describe("checkSource", () => {
  it("names the artifact signed for the tagged commit", () => {
    expect(checkSource(ok())).toBe(`windows-signed-${SHA}`);
  });

  it("accepts a release candidate", () => {
    const rc = ok();
    Object.assign(rc, { version: "0.8.0-rc.2" });
    rc.release.tag_name = "v0.8.0-rc.2";
    expect(checkSource(rc)).toBe(`windows-signed-${SHA}`);
  });

  it.each([
    ["a tag without a release", (s) => (s.release = undefined), /has no GitHub release/],
    ["a draft release", (s) => Object.assign(s.release, { draft: true, published_at: null }), /not published/],
    ["a release for another tag", (s) => (s.release.tag_name = "v0.7.0"), /has no GitHub release/],
    ["a missing tag", (s) => (s.sha = ""), /does not resolve/],
    ["another workflow's run", (s) => (s.run.path = ".github/workflows/desktop.yml"), /not Windows signed/],
    ["a run from a branch", (s) => (s.run.head_branch = "feature"), /not dispatched from main/],
    ["a failed run", (s) => (s.run.conclusion = "failure"), /did not succeed/],
    ["a running run", (s) => Object.assign(s.run, { status: "in_progress", conclusion: null }), /did not succeed/],
    ["no run record", (s) => (s.run = undefined), /not Windows signed/],
    ["a bad version", (s) => (s.version = "v0.7.1"), /invalid version/],
    // Only finals and candidates are meant for a ring (#863, item 7).
    ["a dry run", (s) => (s.version = "0.7.1-dryrun.12"), /not a final or an -rc\.N candidate/],
    ["a beta", (s) => (s.version = "0.7.1-beta.1"), /not a final or an -rc\.N candidate/],
    ["an rc without a number", (s) => (s.version = "0.7.1-rc"), /not a final or an -rc\.N candidate/],
  ])("refuses %s", (_label, change, message) => {
    const source = ok();
    change(source);
    expect(() => checkSource(source)).toThrow(message);
  });
});
