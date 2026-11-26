// Dark work's release notes (changelog.d/incubating/<flag>/, docs/WORKSTREAMS.md): a release never
// renders or deletes them, and the flag's promotion moves them up for the next release.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RELEASE = resolve("tools/release.js");
const release = (cwd, ...args) => execFileSync("node", [RELEASE, ...args], { cwd, encoding: "utf8", stdio: "pipe" });

let work;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "orca-incubating-"));
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "orca", version: "0.8.0" }, null, 2)}\n`);
  writeFileSync(join(work, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\nPending.\n\n");
  mkdirSync(join(work, "changelog.d", "incubating", "planner-v2"), { recursive: true });
  writeFileSync(join(work, "changelog.d", "12-crash.fixed.md"), "- **app:** no crash\n");
  writeFileSync(
    join(work, "changelog.d", "incubating", "planner-v2", "900-planner.added.md"),
    "- **core:** a new planner\n",
  );
});
afterEach(() => rmSync(work, { recursive: true, force: true }));
const dark = () => join(work, "changelog.d", "incubating", "planner-v2", "900-planner.added.md");

describe("incubating fragments", () => {
  it("are neither rendered nor deleted by a release", () => {
    expect(release(work, "notes", "--unreleased")).not.toContain("new planner");
    release(work, "prepare", "0.9.0");
    expect(readFileSync(join(work, "CHANGELOG.md"), "utf8")).not.toContain("new planner");
    expect(existsSync(dark())).toBe(true);
  });

  it("move up with their flag's promotion, and then ship in the next release", () => {
    release(work, "promote", "planner-v2");
    expect(existsSync(dark())).toBe(false);
    expect(existsSync(join(work, "changelog.d", "incubating", "planner-v2"))).toBe(false);
    expect(existsSync(join(work, "changelog.d", "900-planner.added.md"))).toBe(true);
    expect(release(work, "notes", "--unreleased")).toContain("new planner");
  });

  it.each([
    ["a flag with no fragments", "other-flag", () => {}, /has no fragments/],
    ["a name that is not a flag", "../x", () => {}, /not a feature flag name/],
    [
      "a misnamed fragment",
      "planner-v2",
      () => writeFileSync(join(work, "changelog.d", "incubating", "planner-v2", "901-x.new.md"), "- x\n"),
      /<section> is one of/,
    ],
    [
      "a name already taken at the top level",
      "planner-v2",
      () => writeFileSync(join(work, "changelog.d", "900-planner.added.md"), "- other\n"),
      /already exists/,
    ],
  ])("refuses to promote %s, moving nothing", (_, flag, arrange, message) => {
    arrange();
    expect(() => release(work, "promote", flag)).toThrow(message);
    expect(existsSync(dark())).toBe(true);
  });
});
