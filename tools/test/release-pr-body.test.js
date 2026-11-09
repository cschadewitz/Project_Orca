// The release pull request body must stay under GitHub's 65,536-character limit, since
// release-prepare.yml opens the pull request only after the release branch is pushed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { BODY_LIMIT, UNLABELLED_LIMIT, prBody } from "../release-pr-body.js";

// Borrowed from the CLI, which already installs it, as release-workflow.test.js does.
const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");

const base = {
  repo: "o/r",
  number: "7",
  version: "0.7.0-rc.1",
  bump: "minor",
  pin: "v0.7.0-rc.1",
  title: "0.7.0-rc.1",
};
const notesOf = (n) => "x".repeat(n - 1) + "\n";
const issuesOf = (count, width) => Array.from({ length: count }, (_, i) => `#${i} ${"t".repeat(width)}`).join("\n");
const chars = (text) => [...text].length;

describe("release pull request body", () => {
  it("inlines notes that fit, verbatim", () => {
    const body = prBody({ ...base, unlabelled: "", notes: "### Added\n\n- thing\n" });
    expect(body).toContain("Review the notes below first");
    expect(body.endsWith("---\n\n### Added\n\n- thing\n")).toBe(true);
  });

  it.each([59_999, 60_000, 64_000, 64_500, 66_530, 200_000])(
    "stays within the limit with %i characters of notes",
    (n) => {
      const body = prBody({ ...base, unlabelled: issuesOf(60, 100), notes: notesOf(n) });
      expect(chars(body)).toBeLessThanOrEqual(BODY_LIMIT);
    },
  );

  it("links to CHANGELOG.md on the release branch once the notes do not fit", () => {
    const body = prBody({ ...base, unlabelled: "", notes: notesOf(BODY_LIMIT) });
    expect(body).not.toContain("x".repeat(100));
    expect(body).toContain("https://github.com/o/r/blob/release/v0.7.0-rc.1/CHANGELOG.md");
  });

  it("counts the preamble and unlabelled list, not only the notes", () => {
    const notes = notesOf(BODY_LIMIT - 500);
    expect(prBody({ ...base, unlabelled: "", notes })).toContain("x".repeat(100));
    expect(prBody({ ...base, unlabelled: issuesOf(40, 100), notes })).not.toContain("x".repeat(100));
  });

  it("bounds the unlabelled list and says how many were left out", () => {
    const body = prBody({ ...base, unlabelled: issuesOf(UNLABELLED_LIMIT + 7, 10_000), notes: "n\n" });
    expect(chars(body)).toBeLessThan(UNLABELLED_LIMIT * 10_100 + 2_000);
    expect(body).toContain(`…and 7 more.`);
    expect(body).not.toContain(`#${UNLABELLED_LIMIT} `);
  });

  it("counts characters, not UTF-16 units", () => {
    const astral = "😀".repeat(BODY_LIMIT - 1_000);
    expect(prBody({ ...base, unlabelled: "", notes: astral })).toContain("😀".repeat(10));
  });

  it("is built before the release branch is pushed", () => {
    const wf = parse(readFileSync(new URL("../../.github/workflows/release-prepare.yml", import.meta.url), "utf8"));
    const step = Object.values(wf.jobs)
      .flatMap((job) => job.steps)
      .find((s) => s.name === "Open the release pull request");
    expect(step.run.indexOf("release-pr-body.js")).toBeGreaterThan(-1);
    expect(step.run.indexOf("release-pr-body.js")).toBeLessThan(step.run.indexOf("git push"));
  });
});
