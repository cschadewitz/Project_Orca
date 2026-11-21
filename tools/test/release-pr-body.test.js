// The release pull request body must stay under GitHub's 65,536-character limit, since
// release-prepare.yml opens the pull request only after the release branch is pushed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BODY_LIMIT, DRIFT_LIMIT, DRIFT_PATHS, UNLABELLED_LIMIT, prBody } from "../release-pr-body.js";

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

describe("what merging does", () => {
  it("says a prerelease merge tags and publishes", () => {
    const body = prBody({ ...base, unlabelled: "", notes: "- x\n" });
    expect(body).toContain("Merging this tags `v0.7.0-rc.1` and publishes the release.");
  });

  it("says a final merge only stages a .deb-only draft (#865)", () => {
    const body = prBody({ ...base, version: "0.7.0", pin: "v0.7.0", title: "0.7.0", unlabelled: "", notes: "- x\n" });
    expect(body).toContain("stages a **draft** `v0.7.0` with only the Ubuntu amd64 `.deb`");
    expect(body).toContain("It does not tag, publish or write the feed");
    expect(body).not.toContain("publishes the release.");
  });
});

describe("drift since the last candidate (#863)", () => {
  const final = { ...base, version: "0.7.0", pin: "v0.7.0", unlabelled: "", notes: "n\n" };

  it("says nothing for a candidate, or a final with no candidate tag", () => {
    expect(prBody({ ...base, unlabelled: "", notes: "n\n" })).not.toContain("candidate");
    expect(prBody({ ...final, drift: { since: "", stat: "" } })).not.toContain("candidate");
  });

  it("says the final is the candidate's code when nothing it is built from changed", () => {
    const body = prBody({ ...final, drift: { since: "v0.7.0-rc.2", stat: "" } });
    expect(body).toContain("changed since `v0.7.0-rc.2`: this is that candidate's code");
    expect(body).not.toContain("[!WARNING]");
  });

  it("never reads a missing comparison as an empty one", () => {
    const body = prBody({ ...final, drift: { since: "v0.7.0-rc.2", stat: undefined } });
    expect(body).toContain("> [!WARNING]");
    expect(body).toContain("did not run, so drift is unknown");
    expect(body).not.toContain("this is that candidate's code");
  });

  it("refuses to build a body when the comparison output is missing", () => {
    const notes = join(mkdtempSync(join(tmpdir(), "drift-")), "notes.md");
    writeFileSync(notes, "n\n");
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("../release-pr-body.js", import.meta.url)), notes], {
      env: {
        ...process.env,
        REPO: "o/r",
        VERSION: "0.7.0",
        DRIFT_SINCE: "v0.7.0-rc.2",
        DRIFT_FILE: `${notes}.missing`,
      },
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("comparison output");
  });

  it("warns and lists the files that changed, with a comparison link", () => {
    const stat = " packages/app/src/a.ts | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)\n";
    const body = prBody({ ...final, drift: { since: "v0.7.0-rc.2", stat } });
    expect(body).toContain("> [!WARNING]");
    expect(body).toContain("packages/app/src/a.ts | 3 ++-");
    expect(body).toContain("1 file changed");
    expect(body).toContain("https://github.com/o/r/compare/v0.7.0-rc.2...release/v0.7.0");
  });

  it("caps a long list and keeps the summary line", () => {
    const files = Array.from({ length: DRIFT_LIMIT + 10 }, (_, i) => ` packages/f${i}.ts | 1 +`);
    const stat = [...files, ` ${files.length} files changed`].join("\n");
    const body = prBody({ ...final, drift: { since: "v0.7.0-rc.2", stat } });
    expect(body).toContain("…and 11 more files");
    expect(body).toContain(`${files.length} files changed`);
    expect(body).not.toContain(`packages/f${DRIFT_LIMIT + 5}.ts`);
  });

  it("is computed against the newest rc tag, for finals only", () => {
    const wf = parse(readFileSync(new URL("../../.github/workflows/release-prepare.yml", import.meta.url), "utf8"));
    const step = Object.values(wf.jobs)
      .flatMap((job) => job.steps)
      .find((s) => s.name === "Open the release pull request");
    expect(step.run).toContain('if [ "$VERSION" = "$base" ]; then');
    expect(step.run).toContain('git tag -l "v$base-rc.*" --sort=-v:refname | head -n 1');
    expect(step.run.indexOf("DRIFT_SINCE=")).toBeLessThan(step.run.lastIndexOf("node tools/release-pr-body.js"));
  });

  it("compares manifests, the lockfile and root build config, not only sources", () => {
    const wf = parse(readFileSync(new URL("../../.github/workflows/release-prepare.yml", import.meta.url), "utf8"));
    const run = Object.values(wf.jobs)
      .flatMap((job) => job.steps)
      .find((s) => s.name === "Open the release pull request").run;
    const diff = run.match(/git diff --stat=\S+ "\$DRIFT_SINCE" HEAD -- ([^>]+)>/)[1];
    const paths = diff
      .replace(/\\\n/g, " ")
      .trim()
      .split(/\s+/)
      .map((p) => p.replace(/^'(.*)'$/, "$1"));
    expect(paths).toEqual(DRIFT_PATHS);
    expect(diff).not.toContain("exclude");
    for (const path of ["package.json", "pnpm-lock.yaml", "tsconfig*.json"]) expect(DRIFT_PATHS).toContain(path);
  });
});
