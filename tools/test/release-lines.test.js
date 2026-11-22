// Release lines (docs/RELEASING.md, "Release lines"): a patch is cut from `release/X.Y`, never
// from `main`, so work merged for the next minor cannot ship in it. What is protected here is
// that choice of branch, the gate that keeps minor work off a line, the reviewed-commit check
// a real release makes, and main's record of a patch it never merged.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLinePullRequest, inLine, lineOf, referencedIssues } from "../release-line-guard.js";

const RELEASE = fileURLToPath(new URL("../release.js", import.meta.url));
// Borrowed from the CLI, which already installs it, rather than added to the root manifest.
const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));
const release = (cwd, ...args) => execFileSync("node", [RELEASE, ...args], { cwd, encoding: "utf8", stdio: "pipe" });

let work;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "orca-lines-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("the branch a version is cut from", () => {
  it.each([
    ["0.8.0", "main"],
    ["0.8.0-rc.1", "main"],
    ["1.0.0", "main"],
    ["0.7.1", "release/0.7"],
    ["0.7.12", "release/0.7"],
    ["0.7.1-rc.2", "release/0.7"],
    ["1.2.3", "release/1.2"],
  ])("%s comes from %s", (version, branch) => {
    expect(release(work, "line", version).trim()).toBe(branch);
  });

  it("refuses something that is not a version", () => {
    expect(() => release(work, "line", "0.7")).toThrow(/not a semver version/);
  });
});

describe("recording a line release on main", () => {
  const header = "# Changelog\n\nIntro.\n\n## Unreleased\n\nPending entries live in changelog.d/.\n\n";
  const section = (version, body) => `## ${version} - 2026-11-22\n\n### Fixed\n\n- ${body}\n`;
  const write = (name, text) => writeFileSync(join(work, name), text);
  const read = () => readFileSync(join(work, "CHANGELOG.md"), "utf8");

  it("adds the section in version order, below Unreleased and any newer release", () => {
    write("CHANGELOG.md", header + section("0.8.0", "minor") + "\n" + section("0.7.0", "first"));
    write("line.md", header + section("0.7.1", "patch") + "\n" + section("0.7.0", "first"));
    release(work, "sync", "0.7.1", "line.md");
    const text = read();
    const order = ["## Unreleased", "## 0.8.0 ", "## 0.7.1 ", "## 0.7.0 "].map((h) => text.indexOf(h));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("- patch\n");
  });

  it("goes directly under Unreleased when it is the newest release", () => {
    write("CHANGELOG.md", header + section("0.7.0", "first"));
    write("line.md", header + section("0.7.1", "patch") + "\n" + section("0.7.0", "first"));
    release(work, "sync", "0.7.1", "line.md");
    expect(read()).toBe(header + section("0.7.1", "patch") + "\n" + section("0.7.0", "first"));
  });

  it("changes nothing when main already has the same section, and stops on a different one", () => {
    write("CHANGELOG.md", header + section("0.7.1", "patch") + "\n" + section("0.7.0", "first"));
    write("line.md", header + section("0.7.1", "patch") + "\n" + section("0.7.0", "first"));
    const before = read();
    release(work, "sync", "0.7.1", "line.md");
    expect(read()).toBe(before);
    write("line.md", header + section("0.7.1", "something else"));
    expect(() => release(work, "sync", "0.7.1", "line.md")).toThrow(/different 0\.7\.1 section/);
  });

  it("refuses a source without the section", () => {
    write("CHANGELOG.md", header + section("0.7.0", "first"));
    write("line.md", header + section("0.7.0", "first"));
    expect(() => release(work, "sync", "0.7.1", "line.md")).toThrow(/no section for 0\.7\.1/);
  });
});

describe("the release line guard", () => {
  const issue = (milestone, labels = ["release:patch"], isPullRequest = false) => ({
    milestone,
    labels,
    isPullRequest,
  });
  const pr = (over = {}) => ({
    base: "release/0.7",
    head: "fix-crash",
    labels: [],
    milestone: null,
    body: "Fixes #10",
    ...over,
  });

  it("reads lines, milestones and references", () => {
    expect(lineOf("release/0.7")).toEqual({ major: 0, minor: 7 });
    expect(lineOf("release/v0.7.1")).toBeUndefined();
    expect(lineOf("main")).toBeUndefined();
    expect(inLine("0.7.1", { major: 0, minor: 7 })).toBe(true);
    expect(inLine("v0.7.2", { major: 0, minor: 7 })).toBe(true);
    expect(inLine("0.7.0", { major: 0, minor: 7 })).toBe(false);
    expect(inLine("0.8.0", { major: 0, minor: 7 })).toBe(false);
    expect(inLine("Backlog", { major: 0, minor: 7 })).toBe(false);
    expect(referencedIssues("Fixes #10, refs #12 and Backport of #900. Fixes #10 again. See #77.")).toEqual([
      10, 12, 900,
    ]);
  });

  it("passes a fix whose issue is in a patch milestone of the line", () => {
    expect(checkLinePullRequest(pr(), { 10: issue("0.7.1") })).toEqual([]);
  });

  it("passes a backport that names its source pull request beside the issue", () => {
    const body = "Backport of #926.\n\nFixes #10";
    expect(checkLinePullRequest(pr({ body }), { 926: issue("0.8.0", [], true), 10: issue("0.7.2") })).toEqual([]);
  });

  it("passes the release pull request for a patch of the line", () => {
    expect(checkLinePullRequest(pr({ head: "release/v0.7.1", labels: ["release"], body: "" }), {})).toEqual([]);
  });

  it.each([
    ["an issue labelled release:minor", pr(), { 10: issue("0.7.1", ["release:minor"]) }, /release:minor/],
    ["an issue labelled release:major", pr(), { 10: issue("0.7.1", ["release:major"]) }, /release:major/],
    ["an issue in the next minor's milestone", pr(), { 10: issue("0.8.0") }, /milestone "0\.8\.0"/],
    ["an issue in no milestone", pr(), { 10: issue(null) }, /milestone "none"/],
    ["an issue that cannot be read", pr(), {}, /could not be read/],
    ["no issue named at all", pr({ body: "Small fix." }), {}, /name the 0\.7\.x issue/],
    [
      "only a pull request named",
      pr({ body: "Backport of #926" }),
      { 926: issue("0.7.1", [], true) },
      /not only pull requests/,
    ],
    [
      "a pull request labelled release:minor",
      pr({ labels: ["release:minor"] }),
      { 10: issue("0.7.1") },
      /labelled release:minor/,
    ],
    [
      "a pull request in another milestone",
      pr({ milestone: "0.8.0" }),
      { 10: issue("0.7.1") },
      /pull request's milestone/,
    ],
    [
      "a release pull request for another line",
      pr({ head: "release/v0.8.1", labels: ["release"] }),
      {},
      /not a 0\.7\.x patch/,
    ],
    [
      "a release pull request for a minor",
      pr({ head: "release/v0.7.0", labels: ["release"] }),
      {},
      /not a 0\.7\.x patch/,
    ],
    ["a base that is not a line", pr({ base: "release/v0.7.1" }), { 10: issue("0.7.1") }, /not a release line branch/],
  ])("refuses %s", (_, request, issues, message) => {
    const problems = checkLinePullRequest(request, issues);
    expect(problems.join("\n")).toMatch(message);
  });

  it("runs from main for every pull request into a line, and runs none of its code", () => {
    const guard = workflow("release-line-guard.yml");
    expect(Object.keys(guard.on)).toEqual(["pull_request_target"]);
    expect(guard.on.pull_request_target.branches).toEqual(["release/[0-9]*"]);
    expect(guard.permissions).toEqual({ contents: "read", issues: "read", "pull-requests": "read" });
    const steps = guard.jobs.guard.steps;
    expect(guard.jobs.guard.name).toBe("release line check");
    expect(steps[0].with).toEqual({
      ref: "${{ github.event.repository.default_branch }}",
      "persist-credentials": false,
      "sparse-checkout": "tools",
    });
    expect(steps.at(-1).run).toBe("node tools/release-line-guard.js");
  });
});

describe("a real release's reviewed-commit check", () => {
  const step = workflow("release-publish.yml").jobs.check.steps.find(
    (s) => s.name === "A real release builds a reviewed commit from the default branch or its line",
  );
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = (cwd, file, content) => {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
    return git(cwd, "rev-parse", "HEAD");
  };
  const manifest = (version) => `${JSON.stringify({ name: "orca", version })}\n`;
  let clone;
  const commits = {};

  beforeEach(() => {
    const origin = join(work, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    const fork = commit(origin, "package.json", manifest("0.7.0"));
    commits.main = commit(origin, "packages/app/next.ts", "// 0.8 work\n");
    git(origin, "checkout", "-qb", "release/0.7", fork);
    commits.line = commit(origin, "package.json", manifest("0.7.1"));
    git(origin, "checkout", "-qb", "release/0.8", fork);
    commits.otherLine = commit(origin, "package.json", manifest("0.7.2"));
    git(origin, "checkout", "-qb", "topic", fork);
    commits.topic = commit(origin, "package.json", manifest("0.7.3"));
    git(origin, "checkout", "-q", "main");
    clone = join(work, "clone");
    git(work, "clone", "-q", "--no-local", origin, clone);
  });

  const run = (sha, event = "pull_request", ref = "refs/heads/main") =>
    execFileSync("bash", ["-c", step.run], {
      cwd: clone,
      env: {
        ...process.env,
        EVENT: event,
        REF: ref,
        DEFAULT_BRANCH: "main",
        SHA: sha,
        GITHUB_STEP_SUMMARY: join(work, "summary"),
      },
      encoding: "utf8",
      stdio: "pipe",
    });
  const refused = (fn) => {
    try {
      fn();
    } catch (error) {
      return String(error.stdout);
    }
    return undefined;
  };

  it("accepts a commit on main", () => {
    expect(run(commits.main)).toMatch(/from main/);
  });

  it("accepts a patch on its own line branch", () => {
    expect(run(commits.line)).toMatch(/v0\.7\.1\) from its line release\/0\.7/);
  });

  it("refuses a patch that sits on another line or on no line", () => {
    expect(refused(() => run(commits.otherLine))).toMatch(/::error::.* is not on main or release\/0\.7/);
    expect(refused(() => run(commits.topic))).toMatch(/::error::.* is not on main or release\/0\.7/);
  });

  it("refuses a dispatch that does not use main's workflow", () => {
    expect(refused(() => run(commits.line, "workflow_dispatch", "refs/heads/release/0.7"))).toMatch(
      /dispatch a release with the workflow from main/,
    );
  });
});

describe("the patch path through the workflows", () => {
  it("runs CI and the guard on line branches, but never on the release pull request heads", () => {
    const ci = workflow("ci.yml");
    expect(ci.on.pull_request.branches).toEqual(["main", "release/[0-9]*"]);
    expect(ci.on.push.branches).toEqual(["main", "release/[0-9]*"]);
  });

  it("opens the release pull request against the branch the version is cut from", () => {
    const prepare = workflow("release-prepare.yml").jobs.prepare.steps;
    const open = prepare.find((s) => s.name === "Open the release pull request");
    expect(open.env.BASE).toBe("${{ steps.resolve.outputs.base }}");
    expect(open.run).toContain('gh pr create --base "$BASE"');
    const resolve = prepare.find((s) => s.id === "resolve").run;
    expect(resolve).toContain('base=$(node "$tools/release.js" line "$target")');
    expect(resolve).toMatch(/holds minor\/major work/);
    // The App token, when configured, is what lets CI and the guard run on that pull request.
    expect(prepare[0].uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}$/);
    expect(prepare[0].if).toBe("${{ vars.ORCA_RELEASE_APP_ID != '' }}");
  });

  it("records a line release on main with nothing but its notes", () => {
    const sync = workflow("release-publish.yml").jobs["sync-main"];
    expect(sync.needs).toEqual(["check", "publish"]);
    expect(sync.if).toBe("${{ !inputs.dry_run }}");
    expect(sync.steps[0].with.ref).toBe("${{ github.event.repository.default_branch }}");
    const script = sync.steps.at(-1).run;
    expect(script).toContain('node tools/release.js sync "$VERSION"');
    expect(script).toContain("::error::the sync would change more than CHANGELOG.md");
  });
});
