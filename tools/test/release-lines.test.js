// Release lines (docs/RELEASING.md, "Release lines"): a patch is cut from `release/X.Y`, never
// from `main`, so work merged for the next minor cannot ship in it. What is protected here is
// that choice of branch, the gate that keeps minor work off a line, the reviewed-commit check
// a real release makes, and main's record of a patch it never merged.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLinePullRequest, inLine, lineOf, referencedIssues } from "../release-line-guard.js";
import {
  ACTIONS_APP_ID,
  GUARD_WORKFLOW,
  RECEIPT_TITLE,
  guardBinding,
  receiptMessage,
  LINE_CHECKS,
  guardRunProblems,
  isNewLine,
  laneOf,
  protectionProblems,
  releaseDiffProblems,
} from "../release-lane.js";

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
    ["0.8.0", "release/0.8"],
    ["0.9.0-rc.1", "release/0.9"],
    ["1.0.0", "release/1.0"],
    ["0.7.1", "release/0.7"],
    ["0.7.12", "release/0.7"],
    ["0.7.1-rc.2", "release/0.7"],
    ["0.8.1", "release/0.8"],
    ["1.2.3", "release/1.2"],
  ])("%s comes from %s", (version, branch) => {
    expect(release(work, "line", version).trim()).toBe(branch);
  });

  it("refuses something that is not a version", () => {
    expect(() => release(work, "line", "0.7")).toThrow(/not a semver version/);
  });
});

describe("preparing a candidate and its final", () => {
  const header = "# Changelog\n\nIntro.\n\n## Unreleased\n\nPending entries live in changelog.d/.\n\n";
  const setup = () => {
    writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "orca", version: "0.8.0" }, null, 2)}\n`);
    writeFileSync(join(work, "CHANGELOG.md"), header);
    mkdirSync(join(work, "changelog.d"));
    writeFileSync(join(work, "changelog.d", "README.md"), "# Changelog fragments\n");
    writeFileSync(join(work, "changelog.d", "12-crash.fixed.md"), "- **app:** no crash\n");
  };
  const fragment = () => existsSync(join(work, "changelog.d", "12-crash.fixed.md"));

  it("keeps the fragments for a candidate, so the final renders them again, then consumes them", () => {
    setup();
    release(work, "prepare", "0.9.0-rc.1");
    expect(fragment()).toBe(true);
    expect(readFileSync(join(work, "CHANGELOG.md"), "utf8")).toMatch(/## 0\.9\.0-rc\.1 [\s\S]*no crash/);
    writeFileSync(join(work, "changelog.d", "14-hang.fixed.md"), "- **app:** no hang\n");
    release(work, "prepare", "0.9.0");
    expect(fragment()).toBe(false);
    const final = release(work, "notes", "0.9.0");
    expect(final).toContain("no crash");
    expect(final).toContain("no hang");
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

  it("raises main's version to a new minor or its candidate released from its line, never for a patch", () => {
    const version = () => JSON.parse(readFileSync(join(work, "package.json"), "utf8")).version;
    write("package.json", `${JSON.stringify({ name: "orca", version: "0.8.0" }, null, 2)}\n`);
    write("CHANGELOG.md", header + section("0.8.0", "minor"));
    write("line.md", header + section("0.8.1", "patch") + "\n" + section("0.8.0", "minor"));
    release(work, "sync", "0.8.1", "line.md");
    expect(version()).toBe("0.8.0");
    write("line.md", header + section("0.9.0-rc.1", "candidate") + "\n" + section("0.8.0", "minor"));
    release(work, "sync", "0.9.0-rc.1", "line.md");
    expect(version()).toBe("0.9.0-rc.1");
    write("line.md", header + section("0.9.0", "final") + "\n" + section("0.8.0", "minor"));
    release(work, "sync", "0.9.0", "line.md");
    expect(version()).toBe("0.9.0");
    // Candidates order numerically: rc.10 raises main past rc.9, and rc.9's record after it does not lower it.
    write("package.json", `${JSON.stringify({ name: "orca", version: "0.10.0-rc.9" }, null, 2)}\n`);
    write("line.md", header + section("0.10.0-rc.10", "candidate") + "\n" + section("0.9.0", "final"));
    release(work, "sync", "0.10.0-rc.10", "line.md");
    expect(version()).toBe("0.10.0-rc.10");
    write("line.md", header + section("0.10.0-rc.9", "candidate") + "\n" + section("0.9.0", "final"));
    release(work, "sync", "0.10.0-rc.9", "line.md");
    expect(version()).toBe("0.10.0-rc.10");
    write("package.json", `${JSON.stringify({ name: "orca", version: "0.9.0" }, null, 2)}\n`);
    // An older minor's record, after main has moved on, leaves the version alone.
    write("line.md", header + section("0.8.0", "minor"));
    release(work, "sync", "0.8.0", "line.md");
    expect(version()).toBe("0.9.0");
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

  const preparation = {
    files: [
      { filename: "package.json", status: "modified" },
      { filename: "CHANGELOG.md", status: "modified" },
      { filename: "changelog.d/886-sftp.added.md", status: "removed" },
    ],
    basePackage: { name: "orca", version: "0.7.0", private: true },
    headPackage: { name: "orca", version: "0.7.1", private: true },
  };
  const releasePr = (over = {}) =>
    pr({ head: "release/v0.7.1", labels: ["release"], body: "", sameRepository: true, release: preparation, ...over });

  it("passes the release preparation for a patch of the line", () => {
    expect(checkLinePullRequest(releasePr(), {})).toEqual([]);
  });

  it.each([
    ["without the release label", releasePr({ labels: [] }), /must carry the release label/],
    ["with the label on another head", releasePr({ head: "fix-crash" }), /head must be release\/vX\.Y\.Z/],
    ["from a fork", releasePr({ sameRepository: false }), /from this repository/],
    ["for another line", releasePr({ head: "release/v0.6.1" }), /cut from release\/0\.6, not release\/0\.7/],
    ["for the next minor", releasePr({ head: "release/v0.8.0" }), /cut from release\/0\.8, not release\/0\.7/],
    [
      "that changes code",
      releasePr({
        release: {
          ...preparation,
          files: [...preparation.files, { filename: "packages/app/x.ts", status: "modified" }],
        },
      }),
      /packages\/app\/x\.ts \(modified\) is not part of a release preparation/,
    ],
    [
      "that adds a fragment",
      releasePr({ release: { ...preparation, files: [{ filename: "changelog.d/1-x.added.md", status: "added" }] } }),
      /not part of a release preparation/,
    ],
    [
      "that changes package.json beyond its version",
      releasePr({ release: { ...preparation, headPackage: { ...preparation.headPackage, scripts: { x: "y" } } } }),
      /more than its version/,
    ],
    [
      "whose head is not at its version",
      releasePr({ release: { ...preparation, headPackage: { ...preparation.headPackage, version: "0.7.2" } } }),
      /says 0\.7\.2, not 0\.7\.1/,
    ],
  ])("refuses a release pull request %s", (_, request, message) => {
    expect(checkLinePullRequest(request, {}).join("\n")).toMatch(message);
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
    ["a base that is not a line", pr({ base: "release/v0.7.1" }), { 10: issue("0.7.1") }, /not a release line branch/],
  ])("refuses %s", (_, request, issues, message) => {
    const problems = checkLinePullRequest(request, issues);
    expect(problems.join("\n")).toMatch(message);
  });

  describe("while the line stabilizes its .0 (no vX.Y.0 tag yet)", () => {
    const stabilizing = { stabilizing: true };
    const next = (over = {}) => pr({ base: "release/0.9", ...over });

    it("reads the line's .0 milestone as the line's only then", () => {
      expect(inLine("0.9.0", { major: 0, minor: 9 }, { zero: true })).toBe(true);
      expect(inLine("0.9.0", { major: 0, minor: 9 })).toBe(false);
      expect(inLine("0.10.0", { major: 0, minor: 9 }, { zero: true })).toBe(false);
    });

    it("passes a fix whose issue is in the .0 milestone, with the minor bump it ships with", () => {
      expect(checkLinePullRequest(next(), { 10: issue("0.9.0", ["release:minor"]) }, stabilizing)).toEqual([]);
      expect(
        checkLinePullRequest(
          next({ milestone: "0.9.0", labels: ["release:minor"] }),
          { 10: issue("0.9.0") },
          stabilizing,
        ),
      ).toEqual([]);
    });

    it("passes the release preparation of the .0 or its candidate", () => {
      const candidate = {
        ...preparation,
        basePackage: { ...preparation.basePackage, version: "0.8.0" },
        headPackage: { ...preparation.headPackage, version: "0.9.0-rc.1" },
      };
      expect(
        checkLinePullRequest(
          next({ ...releasePr({ head: "release/v0.9.0-rc.1", release: candidate }), base: "release/0.9" }),
          {},
          stabilizing,
        ),
      ).toEqual([]);
    });

    it.each([
      ["the next minor's issue", { 10: issue("0.10.0", ["release:minor"]) }, /milestone "0\.10\.0"/],
      ["a minor issue outside the .0 milestone", { 10: issue("0.9.1", ["release:minor"]) }, /labelled release:minor/],
    ])("still refuses %s", (_, issues, message) => {
      expect(checkLinePullRequest(next(), issues, stabilizing).join("\n")).toMatch(message);
    });

    it("refuses the .0 milestone once the .0 is tagged", () => {
      expect(checkLinePullRequest(next(), { 10: issue("0.9.0", ["release:minor"]) }).join("\n")).toMatch(
        /release:minor[\s\S]*not a 0\.9\.x patch milestone/,
      );
    });
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

describe("the lane policy", () => {
  const protectedRules = [
    { type: "pull_request" },
    { type: "non_fast_forward" },
    { type: "deletion" },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: LINE_CHECKS.map((context) => ({ context, integration_id: ACTIONS_APP_ID })),
      },
    },
  ];

  it("puts every release of a minor, its .0 and candidates included, on that minor's line", () => {
    expect(laneOf("0.8.1")).toBe("release/0.8");
    expect(laneOf("1.0.1")).toBe("release/1.0");
    expect(laneOf("0.9.0")).toBe("release/0.9");
    expect(isNewLine("0.9.0-rc.1")).toBe(true);
    expect(isNewLine("0.9.1")).toBe(false);
  });

  it.each([
    ["0.8.0", "release/0.8"],
    ["0.8.0-rc.2", "release/0.8"],
    ["0.7.1", "release/0.7"],
    ["0.7.1-rc.1", "release/0.7"],
  ])("puts %s on %s", (version, lane) => {
    expect(laneOf(version)).toBe(lane);
  });

  it("accepts a line protected by pull requests, no force push or deletion, and both checks", () => {
    expect(protectionProblems(protectedRules)).toEqual([]);
  });

  it.each([
    ["no rules at all", []],
    ["no pull request rule", protectedRules.filter((r) => r.type !== "pull_request")],
    ["force pushes allowed", protectedRules.filter((r) => r.type !== "non_fast_forward")],
    ["deletion allowed", protectedRules.filter((r) => r.type !== "deletion")],
    [
      "the guard not required",
      protectedRules.map((r) =>
        r.type === "required_status_checks"
          ? { ...r, parameters: { ...r.parameters, required_status_checks: [{ context: "check (node 24)" }] } }
          : r,
      ),
    ],
    [
      "checks any app may satisfy",
      protectedRules.map((r) =>
        r.type === "required_status_checks"
          ? {
              ...r,
              parameters: { ...r.parameters, required_status_checks: LINE_CHECKS.map((context) => ({ context })) },
            }
          : r,
      ),
    ],
    [
      "branches allowed to be behind",
      protectedRules.map((r) =>
        r.type === "required_status_checks"
          ? { ...r, parameters: { ...r.parameters, strict_required_status_checks_policy: false } }
          : r,
      ),
    ],
  ])("refuses a line with %s", (_, rules) => {
    expect(protectionProblems(rules).length).toBeGreaterThan(0);
  });

  describe("whose release line check counts", () => {
    const head = "a".repeat(40);
    const pr = { number: 906, base: "release/0.7" };
    const receipt = (over = {}) => [
      {
        annotation_level: "notice",
        title: RECEIPT_TITLE,
        message: receiptMessage({ number: 906, base: "release/0.7", head, ...over }),
      },
    ];
    // As GitHub reports a pull_request_target run: no pull_requests, and the display title is
    // the pull request's own title.
    const checkRun = { conclusion: "success", head_sha: head, app: { slug: "github-actions" }, pull_requests: [] };
    const workflowRun = {
      path: GUARD_WORKFLOW,
      event: "pull_request_target",
      head_sha: head,
      display_title: "release line check: #906 into release/0.7",
      pull_requests: [],
    };

    it("is main's guard workflow, run by Actions on the exact head, with its receipt for this PR", () => {
      expect(guardRunProblems(checkRun, workflowRun, receipt(), head, pr)).toEqual([]);
    });

    it.each([
      ["this pull request's receipt", checkRun, receipt(), "this"],
      [
        "GitHub's link to this pull request",
        { ...checkRun, pull_requests: [{ number: 906, base: { ref: "release/0.7" }, head: { sha: head } }] },
        [],
        "this",
      ],
      ["another pull request's receipt", checkRun, receipt({ number: 907 }), "other"],
      [
        "GitHub's link to another pull request",
        { ...checkRun, pull_requests: [{ number: 907, base: { ref: "release/0.7" } }] },
        [],
        "other",
      ],
      [
        "no receipt and no link: failed or cancelled before writing it",
        { ...checkRun, conclusion: "failure" },
        [],
        "unbound",
      ],
      ["a receipt that is not JSON", checkRun, [{ ...receipt()[0], message: "{pr:906" }], "unbound"],
      [
        "a receipt with a missing field",
        checkRun,
        [{ ...receipt()[0], message: '{"pr":907,"base":"release/0.7"}' }],
        "unbound",
      ],
      [
        "a receipt with an extra field",
        checkRun,
        [{ ...receipt()[0], message: receipt()[0].message.replace("}", ',"x":1}') }],
        "unbound",
      ],
      [
        "a receipt whose number is a string",
        checkRun,
        [{ ...receipt()[0], message: receipt()[0].message.replace("906", '"907"') }],
        "unbound",
      ],
      [
        "receipts naming both this and another pull request",
        checkRun,
        [...receipt(), ...receipt({ number: 907 })],
        "unbound",
      ],
      ["a link without a number", { ...checkRun, pull_requests: [{ base: { ref: "release/0.7" } }] }, [], "unbound"],
    ])("binds an attempt with %s as %s", (_, run, annotations, binding) => {
      expect(guardBinding(run, annotations, head, pr)).toBe(binding);
    });

    it("still accepts GitHub's own pull_requests link where it is filled", () => {
      const linked = [{ number: 906, base: { ref: "release/0.7" }, head: { sha: head } }];
      expect(guardRunProblems({ ...checkRun, pull_requests: linked }, workflowRun, [], head, pr)).toEqual([]);
    });

    it.each([
      ["a failure", { ...checkRun, conclusion: "failure" }, workflowRun, receipt(), /did not succeed/],
      ["another head", { ...checkRun, head_sha: "b".repeat(40) }, workflowRun, receipt(), /ran on b+/],
      ["another app", { ...checkRun, app: { slug: "someone" } }, workflowRun, receipt(), /posted by someone/],
      ["another workflow", checkRun, { ...workflowRun, path: ".github/workflows/ci.yml" }, receipt(), /came from/],
      [
        "the pull request's own code",
        checkRun,
        { ...workflowRun, event: "pull_request" },
        receipt(),
        /pull_request event/,
      ],
      ["no workflow run", checkRun, undefined, receipt(), /no workflow/],
      // A run from before the receipt: its display title is whatever the PR was titled, which
      // its author chose, so a matching title proves nothing.
      ["a legacy run titled like a binding, without a receipt", checkRun, workflowRun, [], /not linked/],
      ["another pull request's receipt", checkRun, workflowRun, receipt({ number: 907 }), /not linked to #906/],
      ["another line's receipt", checkRun, workflowRun, receipt({ base: "release/0.6" }), /into release\/0\.7/],
      ["another head's receipt", checkRun, workflowRun, receipt({ head: "c".repeat(40) }), /not linked/],
      [
        "a receipt with another title",
        checkRun,
        workflowRun,
        [{ ...receipt()[0], title: "release line receipt v0" }],
        /not linked/,
      ],
      [
        "a receipt that is not a notice",
        checkRun,
        workflowRun,
        [{ ...receipt()[0], annotation_level: "failure" }],
        /not linked/,
      ],
    ])("is not %s", (_, run, workflow, annotations, message) => {
      expect(guardRunProblems(run, workflow, annotations, head, pr).join("; ")).toMatch(message);
    });
  });

  it("knows a release preparation from anything else", () => {
    const files = [
      { filename: "package.json", status: "modified" },
      { filename: "CHANGELOG.md", status: "modified" },
    ];
    const basePackage = { version: "0.7.0" };
    expect(releaseDiffProblems({ version: "0.7.1", files, basePackage, headPackage: { version: "0.7.1" } })).toEqual(
      [],
    );
    expect(
      releaseDiffProblems({
        version: "0.7.1",
        files: [...files, { filename: "changelog.d/README.md", status: "removed" }],
        basePackage,
        headPackage: { version: "0.7.1" },
      }).join("\n"),
    ).toMatch(/README\.md/);
  });
});

describe("a real release's reviewed-commit check", () => {
  const step = workflow("release-publish.yml").jobs.check.steps.find(
    (s) => s.name === "A real release builds a reviewed commit from its lane",
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
  const protectedRules = JSON.stringify([
    { type: "pull_request" },
    { type: "non_fast_forward" },
    { type: "deletion" },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: LINE_CHECKS.map((context) => ({ context, integration_id: ACTIONS_APP_ID })),
      },
    },
  ]);
  let clone;
  let bin;
  const commits = {};

  beforeEach(() => {
    const origin = join(work, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    commit(origin, "tools/release-lane.js", readFileSync(new URL("../release-lane.js", import.meta.url), "utf8"));
    const fork = commit(origin, "package.json", manifest("0.7.0"));
    commits.main = commit(origin, "packages/app/next.ts", "// 0.8 work\n");
    commits.patchOnMain = commit(origin, "package.json", manifest("0.7.9"));
    git(origin, "checkout", "-qb", "release/0.7", fork);
    commits.line = commit(origin, "package.json", manifest("0.7.1"));
    commits.minorOnLine = commit(origin, "package.json", manifest("0.8.0"));
    git(origin, "reset", "-q", "--hard", commits.line);
    git(origin, "checkout", "-qb", "release/0.8", fork);
    commits.otherLine = commit(origin, "package.json", manifest("0.7.2"));
    // The same version as the line's release commit, with more in its tree.
    commit(origin, "package.json", manifest("0.7.1"));
    commits.reworked = commit(origin, "packages/app/extra.ts", "// not reviewed\n");
    // A new minor's line, cut from main, with its first candidate.
    git(origin, "checkout", "-qb", "release/0.9", commits.main);
    commits.candidate = commit(origin, "package.json", manifest("0.9.0-rc.1"));
    git(origin, "checkout", "-q", "main");
    git(origin, "reset", "-q", "--hard", commits.main);
    clone = join(work, "clone");
    git(work, "clone", "-q", "--no-local", origin, clone);
    // The minor commit is reachable from nowhere on origin but exists in the clone's objects.
    git(clone, "fetch", "-q", origin, commits.minorOnLine);
    git(clone, "fetch", "-q", origin, commits.patchOnMain);
    // gh answers the rules API from RULES, check runs from CHECKS, a check run's annotations from
    // ANN_<id> (else ANN) and workflow runs from RUNS_<suite> (else RUNS).
    bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      '#!/bin/sh\ncase "$*" in *check-runs/*/annotations*) id=$(echo "$*" | sed -n "s/.*check-runs\\/\\([0-9]*\\)\\/annotations.*/\\1/p"); eval "v=\\${ANN_$id:-\\$ANN}"; printf "%s" "$v";; *rules/branches*) printf "%s" "$RULES";; *check-runs*) printf "%s" "$CHECKS";; *actions/runs*) id=$(echo "$*" | sed -n "s/.*check_suite_id=\\([0-9]*\\).*/\\1/p"); eval "v=\\${RUNS_$id:-\\$RUNS}"; printf "%s" "$v";; *) exit 1;; esac\n',
      { mode: 0o755 },
    );
  });

  const run = ({
    sha,
    event = "workflow_dispatch",
    ref = "refs/heads/main",
    rules = protectedRules,
    checks,
    runs,
    suites = {},
    receipts = {},
    annotations,
    eventFile,
  }) =>
    execFileSync("bash", ["-c", step.run], {
      cwd: clone,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        EVENT: event,
        REF: ref,
        DEFAULT_BRANCH: "main",
        SHA: sha,
        RULES: rules,
        CHECKS: checks ?? guardChecks(),
        RUNS: runs ?? guardRuns(),
        ...Object.fromEntries(Object.entries(suites).map(([id, run]) => [`RUNS_${id}`, run])),
        ANN: annotations ?? receiptFor(906),
        ...Object.fromEntries(Object.entries(receipts).map(([id, ann]) => [`ANN_${id}`, ann])),
        GITHUB_EVENT_PATH: eventFile ?? "/dev/null",
        GITHUB_REPOSITORY: "o/r",
        RUNNER_TEMP: work,
        GITHUB_STEP_SUMMARY: join(work, "summary"),
      },
      encoding: "utf8",
      stdio: "pipe",
    });
  // The release line check as main's guard posts it on the reviewed head.
  const guardChecks = (over = {}) =>
    JSON.stringify({
      check_runs: [
        {
          id: 1,
          conclusion: "success",
          head_sha: commits.line,
          app: { slug: "github-actions" },
          check_suite: { id: 2 },
          // As GitHub reports a pull_request_target run: no pull_requests; the receipt binds it.
          pull_requests: [],
          ...over,
        },
      ],
    });
  const guardRuns = (over = {}) =>
    JSON.stringify({
      workflow_runs: [
        {
          path: GUARD_WORKFLOW,
          event: "pull_request_target",
          head_sha: commits.line,
          display_title: "the pull request's own title",
          pull_requests: [],
          ...over,
        },
      ],
    });
  // The receipt main's guard writes on its check run for #906 at the reviewed head.
  const receiptFor = (number, head = commits.line) =>
    JSON.stringify([
      {
        annotation_level: "notice",
        title: RECEIPT_TITLE,
        message: receiptMessage({ number, base: "release/0.7", head }),
      },
    ]);
  const refused = (fn) => {
    try {
      fn();
    } catch (error) {
      return String(error.stdout);
    }
    return undefined;
  };
  const merged = (over = {}) => {
    const file = join(work, "event.json");
    writeFileSync(
      file,
      JSON.stringify({
        pull_request: {
          number: 906,
          merged: true,
          head: { ref: "release/v0.7.1", sha: commits.line, repo: { full_name: "o/r" } },
          base: { ref: "release/0.7" },
          ...over,
        },
      }),
    );
    return file;
  };

  describe("a dry run's look at the gate", () => {
    const rehearsal = workflow("release-publish.yml").jobs.check.steps.find(
      (s) => s.name === "Rehearse the lane gate (report only)",
    );
    const rehearse = (sha) =>
      execFileSync("bash", ["-c", rehearsal.run], {
        cwd: clone,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEFAULT_BRANCH: "main",
          SHA: sha,
          RULES: protectedRules,
          GITHUB_REPOSITORY: "o/r",
          RUNNER_TEMP: work,
          GITHUB_STEP_SUMMARY: join(work, "summary"),
        },
        encoding: "utf8",
        stdio: "pipe",
      });

    it("runs only in a dry run, and reports without refusing", () => {
      expect(rehearsal.if).toBe("${{ inputs.dry_run }}");
      expect(rehearse(commits.candidate)).toMatch(/would accept: .* \(v0\.9\.0-rc\.1\) is on release\/0\.9/);
      expect(rehearse(commits.main)).toMatch(
        /would refuse: .* \(v0\.7\.0\) is neither on release\/0\.7 nor up to date/,
      );
      expect(readFileSync(join(work, "summary"), "utf8")).toContain("Rehearsed lane gate would refuse");
    });

    it("reports only a preflight for a release pull request head that is up to date with its line", () => {
      git(clone, "checkout", "-q", "--detach", commits.candidate);
      writeFileSync(join(clone, "package.json"), manifest("0.9.0"));
      git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "release: v0.9.0");
      expect(rehearse(git(clone, "rev-parse", "HEAD"))).toMatch(
        /preflight passed \(ancestry and protection only\): .* \(v0\.9\.0\) is up to date with protected release\/0\.9.*same tree/,
      );
    });
  });

  it("accepts a new minor's candidate on its own line, cut from main", () => {
    expect(run({ sha: commits.candidate })).toMatch(/v0\.9\.0-rc\.1\) from release\/0\.9/);
  });

  it("accepts a patch on its own protected line", () => {
    expect(run({ sha: commits.line })).toMatch(/v0\.7\.1\) from release\/0\.7/);
  });

  it.each([
    ["a patch on main", () => commits.patchOnMain, protectedRules, /is not on release\/0\.7/],
    ["a patch on another line", () => commits.otherLine, protectedRules, /is not on release\/0\.7/],
    ["a minor on another line", () => commits.minorOnLine, protectedRules, /is not on release\/0\.8/],
    ["a minor on main", () => commits.main, protectedRules, /is not on release\/0\.7/],
    ["a patch on an unprotected line", () => commits.line, "[]", /not protected as a release line/],
  ])("refuses %s", (_, sha, rules, message) => {
    expect(refused(() => run({ sha: sha(), rules }))).toMatch(message);
  });

  it("refuses a dispatch that does not use main's workflow", () => {
    expect(refused(() => run({ sha: commits.line, ref: "refs/heads/release/0.7" }))).toMatch(
      /dispatch a release with the workflow from main/,
    );
  });

  it("accepts a merged release pull request that is the reviewed preparation", () => {
    expect(run({ sha: commits.line, event: "pull_request", eventFile: merged() })).toMatch(/from release\/0\.7/);
  });

  it.each([
    ["into the wrong branch", { base: { ref: "main" } }, undefined, /merged into main/],
    [
      "from a fork",
      { head: { ref: "release/v0.7.1", sha: "x", repo: { full_name: "fork/r" } } },
      undefined,
      /from this repository/,
    ],
    [
      "whose head is not a release head",
      { head: { ref: "fix", sha: "x", repo: { full_name: "o/r" } } },
      undefined,
      /not a release pull request head/,
    ],
    ["whose guard did not pass", {}, () => guardChecks({ conclusion: "failure" }), /did not pass on the reviewed head/],
    [
      "whose guard check another app posted",
      {},
      () => guardChecks({ app: { slug: "impostor" } }),
      /no release line check, as main runs it, for #906/,
    ],
    [
      "whose version is not the one package.json holds",
      { head: { ref: "release/v0.7.2", sha: null, repo: { full_name: "o/r" } } },
      undefined,
      /says 0\.7\.1, not 0\.7\.2/,
    ],
  ])("refuses a merged release pull request %s", (_, over, checks, message) => {
    if (over.head?.sha === null) over.head.sha = commits.line;
    expect(
      refused(() => run({ sha: commits.line, event: "pull_request", eventFile: merged(over), checks: checks?.() })),
    ).toMatch(message);
  });

  // Check runs, each with the receipt for the pull request it judged.
  const runsOf = (...entries) => ({
    checks: JSON.stringify({
      check_runs: entries.map(([id, conclusion]) => ({
        ...JSON.parse(guardChecks()).check_runs[0],
        id,
        conclusion,
        check_suite: { id: id + 100 },
      })),
    }),
    receipts: Object.fromEntries(entries.map(([id, , number]) => [id, number ? receiptFor(number) : "[]"])),
  });

  it("counts only this pull request's newest guard result: a later failure outlives an older pass", () => {
    const eventFile = merged();
    expect(
      refused(() =>
        run({
          sha: commits.line,
          event: "pull_request",
          eventFile,
          ...runsOf([1, "success", 906], [3, "failure", 906]),
        }),
      ),
    ).toMatch(/newest result for #906, check run 3: it did not succeed/);
    // Another pull request's newer result on the same commit is not this one's.
    expect(
      run({
        sha: commits.line,
        event: "pull_request",
        eventFile,
        ...runsOf([1, "success", 906], [5, "failure", 907]),
      }),
    ).toMatch(/from release\/0\.7/);
    expect(
      refused(() => run({ sha: commits.line, event: "pull_request", eventFile, ...runsOf([5, "success", 907]) })),
    ).toMatch(/no release line check, as main runs it, for #906 into release\/0\.7/);
  });

  it("treats a newer attempt that failed before its receipt as inconclusive, never falling back to an older pass", () => {
    const eventFile = merged();
    expect(
      refused(() =>
        run({
          sha: commits.line,
          event: "pull_request",
          eventFile,
          ...runsOf([1, "success", 906], [4, "failure", null]),
        }),
      ),
    ).toMatch(/check run 4, failure\) left no receipt, so whether #906 into release\/0\.7 passed is inconclusive/);
    expect(
      refused(() =>
        run({
          sha: commits.line,
          event: "pull_request",
          eventFile,
          ...runsOf([1, "success", 906], [4, "cancelled", null]),
        }),
      ),
    ).toMatch(/check run 4, cancelled\) left no receipt/);
    // A newer attempt shown to be another pull request's does not hide this one's pass.
    expect(
      run({ sha: commits.line, event: "pull_request", eventFile, ...runsOf([1, "success", 906], [4, "failure", 907]) }),
    ).toMatch(/from release\/0\.7/);
  });

  it("refuses a legacy guard pass that has no receipt, whatever its run is titled", () => {
    expect(
      refused(() =>
        run({
          sha: commits.line,
          event: "pull_request",
          eventFile: merged(),
          annotations: "[]",
          runs: guardRuns({ display_title: "release line check: #906 into release/0.7" }),
        }),
      ),
    ).toMatch(/left no receipt, so whether #906 into release\/0\.7 passed is inconclusive/);
  });

  it("refuses a release line check that main's guard did not run", () => {
    expect(
      refused(() =>
        run({
          sha: commits.line,
          event: "pull_request",
          eventFile: merged(),
          runs: guardRuns({ event: "pull_request", path: ".github/workflows/other.yml" }),
        }),
      ),
    ).toMatch(/no release line check, as main runs it, for #906/);
  });

  it("refuses a minor's release pull request merged into main: its lane is its own line", () => {
    const head = { ref: "release/v0.7.0", sha: commits.main, repo: { full_name: "o/r" } };
    expect(
      refused(() =>
        run({ sha: commits.main, event: "pull_request", eventFile: merged({ head, base: { ref: "main" } }) }),
      ),
    ).toMatch(/is not on release\/0\.7/);
  });

  it("refuses a merge commit whose tree is not the reviewed head's", () => {
    const head = { ref: "release/v0.7.1", sha: commits.reworked, repo: { full_name: "o/r" } };
    expect(refused(() => run({ sha: commits.line, event: "pull_request", eventFile: merged({ head }) }))).toMatch(
      /is not the reviewed head/,
    );
  });
});

describe("the patch path through the workflows", () => {
  it("runs CI and the guard on line branches, but never on the release pull request heads", () => {
    const ci = workflow("ci.yml");
    expect(ci.on.pull_request.branches).toEqual(["main", "release/[0-9]*", "feature/**"]);
    expect(ci.on.push.branches).toEqual(["main", "release/[0-9]*", "feature/**"]);
  });

  it("opens the release pull request against the branch the version is cut from", () => {
    const prepare = workflow("release-prepare.yml").jobs.prepare.steps;
    const open = prepare.find((s) => s.name === "Open the release pull request");
    expect(open.env.BASE).toBe("${{ steps.resolve.outputs.base }}");
    expect(open.run).toContain('gh pr create --base "$BASE"');
    const resolve = prepare.find((s) => s.id === "resolve").run;
    expect(resolve).toContain('node "$tools/release-plan.js" plan --bump "$bump" --pin "$pin" --title "$title"');
    // Nothing is pushed before the plan has passed.
    expect(resolve.indexOf('release-plan.js" plan')).toBeLessThan(resolve.indexOf("git push"));
    expect(resolve).toMatch(/holds minor\/major work/);
    // The App token, when configured, is what lets CI and the guard run on that pull request.
    expect(prepare[0].uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}$/);
    expect(prepare[0].if).toBe("${{ (vars.ORRERY_RELEASE_APP_ID || vars.ORCA_RELEASE_APP_ID) != '' }}");
  });

  it("records a line release on main only once it is published, through main's review", () => {
    // Release (publish) only drafts a final, so it requests the record for prereleases alone;
    // Release (publish final) requests it after its read-back.
    const record = workflow("release-publish.yml").jobs["record-line-release"];
    expect(record.needs).toEqual(["check", "publish"]);
    expect(record.if).toBe("${{ !inputs.dry_run && contains(needs.check.outputs.version, '-') }}");
    expect(workflow("release-publish.yml").jobs["sync-main"]).toBeUndefined();

    const sync = workflow("release-sync-main.yml");
    expect(Object.keys(sync.on)).toEqual(["workflow_dispatch"]);
    const job = sync.jobs.sync;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("release-bot");
    expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    const readBack = job.steps.find((step) => step.id === "release").run;
    expect(readBack).toContain('gh api "repos/$REPO/releases/tags/v$VERSION"');
    expect(readBack).toContain('[ "$draft" != false ]');
    expect(readBack).toContain('node tools/release-lane.js verify "$sha" "$VERSION"');
    const script = job.steps.at(-1).run;
    expect(job.steps.at(-1).if).toBe("steps.release.outputs.sha != ''");
    expect(script).toContain('node tools/release.js sync "$VERSION"');
    expect(script).toContain("::error::the sync would change more than CHANGELOG.md");
    // Only the exact fragments the release consumed, only where main's copy is identical.
    expect(script).toContain('git diff --diff-filter=D --name-only "$SHA^1" "$SHA" -- changelog.d/');
    expect(script).toContain('"$(git rev-parse "$SHA^1:$file")" = "$(git hash-object -- "$file")"');
    // One branch per version, reused; left for review, never merged or auto-merged here.
    expect(script).toContain('branch="release-sync/v$VERSION"');
    expect(script).not.toContain("gh pr merge");
  });

  it("keeps the release App's key in the main-only environment", () => {
    expect(workflow("release-prepare.yml").jobs.prepare.environment).toBe("release-bot");
    for (const name of ["release-publish.yml", "release-publish-final.yml", "ci.yml"])
      expect(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8")).not.toContain(
        "ORCA_RELEASE_APP_PRIVATE_KEY",
      );
  });
});

describe("Release (sync main) on a rerun", () => {
  const step = workflow("release-sync-main.yml").jobs.sync.steps.find((s) => s.name === "Record the release on main");
  const header = "# Changelog\n\nIntro.\n\n## Unreleased\n\nPending entries live in changelog.d/.\n\n";
  const section = (version, body) => `## ${version} - 2026-11-22\n\n### Fixed\n\n- ${body}\n`;
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commitAll = (cwd, message) => {
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  let origin;
  let clone;
  let sha;
  let log;

  beforeEach(() => {
    origin = join(work, "origin");
    mkdirSync(join(origin, "tools"), { recursive: true });
    mkdirSync(join(origin, "changelog.d"));
    git(origin, "init", "-q", "-b", "main");
    for (const tool of ["release.js", "changelog.js", "release-lane.js", "release-plan.js"])
      writeFileSync(join(origin, "tools", tool), readFileSync(new URL(`../${tool}`, import.meta.url), "utf8"));
    writeFileSync(join(origin, "CHANGELOG.md"), header + section("0.7.0", "first"));
    writeFileSync(join(origin, "changelog.d", "12-crash.fixed.md"), "- app: no crash\n");
    commitAll(origin, "base");
    // The line's release commit: the section added, the fragment consumed.
    git(origin, "checkout", "-qb", "release/0.7");
    writeFileSync(
      join(origin, "CHANGELOG.md"),
      header + section("0.7.1", "no crash") + "\n" + section("0.7.0", "first"),
    );
    rmSync(join(origin, "changelog.d", "12-crash.fixed.md"));
    sha = commitAll(origin, "release 0.7.1");
    git(origin, "checkout", "-q", "main");
    clone = join(work, "clone");
    git(work, "clone", "-q", "--no-local", origin, clone);
    git(clone, "fetch", "-q", "origin", "release/0.7");
    const bin = join(work, "bin");
    mkdirSync(bin);
    log = join(work, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      '#!/bin/sh\necho "$*" >> "$LOG"\ncase "$1 $2" in "pr list") printf "%s\\n" "$PRS";; "pr create") echo https://x/pull/1;; "pr merge") ;; *) exit 1;; esac\n',
      { mode: 0o755 },
    );
  });

  // Every run starts from a fresh checkout of main, as in Actions.
  const run = (prs = " ") => {
    git(clone, "fetch", "-q", "origin", "main");
    git(clone, "reset", "-q", "--hard", "FETCH_HEAD");
    return execFileSync("bash", ["-c", step.run], {
      cwd: clone,
      env: {
        ...process.env,
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        LOG: log,
        PRS: prs,
        GH_TOKEN: "t",
        REPO: "o/r",
        DEFAULT_BRANCH: "main",
        SHA: sha,
        VERSION: "0.7.1",
        RUNNER_TEMP: work,
        GITHUB_STEP_SUMMARY: join(work, "summary"),
      },
      encoding: "utf8",
      stdio: "pipe",
    });
  };
  const branchHead = () => git(origin, "rev-parse", "refs/heads/release-sync/v0.7.1");
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

  it("opens one pull request and leaves it for review", () => {
    run();
    const head = branchHead();
    expect(git(origin, "show", `${head}:CHANGELOG.md`)).toContain("## 0.7.1 ");
    expect(calls()).toContain("pr create");
    expect(calls()).not.toContain("pr merge");
    expect(readFileSync(join(work, "summary"), "utf8")).toContain(`waits for review at \`${head}\``);
  });

  it("reuses an identical result on a rerun without pushing over it, even after main moved", () => {
    run();
    const head = branchHead();
    writeFileSync(join(origin, "README.md"), "moved\n");
    commitAll(origin, "main moved");
    rmSync(log);
    run(`https://x/pull/1 ${head}`);
    expect(branchHead()).toBe(head);
    expect(calls()).not.toContain("pr create");
    expect(calls()).not.toContain("pr merge");
  });

  it("stops, changing nothing, when the branch holds an edit", () => {
    run();
    git(origin, "checkout", "-q", "release-sync/v0.7.1");
    writeFileSync(join(origin, "CHANGELOG.md"), `${readFileSync(join(origin, "CHANGELOG.md"), "utf8")}\nedited\n`);
    const edited = commitAll(origin, "a reviewer's edit");
    git(origin, "checkout", "-q", "main");
    rmSync(log);
    let out = "";
    try {
      run(`https://x/pull/1 ${edited}`);
    } catch (error) {
      out = String(error.stdout);
    }
    expect(out).toMatch(/already holds a different change/);
    expect(branchHead()).toBe(edited);
    expect(calls()).not.toMatch(/pr (create|merge)/);
  });

  it("stops when the open pull request is not at the head it checked", () => {
    run();
    rmSync(log);
    let out = "";
    try {
      run(`https://x/pull/1 ${"f".repeat(40)}`);
    } catch (error) {
      out = String(error.stdout);
    }
    expect(out).toMatch(/is at f+, not/);
    expect(calls()).not.toContain("pr merge");
  });
});

describe("the guard's receipt", () => {
  it("is written first, for the pull request, line and head it judged, even when it refuses", () => {
    const event = join(work, "pr.json");
    writeFileSync(
      event,
      JSON.stringify({
        pull_request: {
          number: 77,
          body: "",
          labels: [],
          milestone: null,
          base: { ref: "release/0.7", sha: "b".repeat(40) },
          head: { ref: "fix", sha: "c".repeat(40), repo: { full_name: "o/r" } },
        },
      }),
    );
    const guard = spawnSync(process.execPath, [fileURLToPath(new URL("../release-line-guard.js", import.meta.url))], {
      env: { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "o/r" },
      encoding: "utf8",
    });
    expect(guard.status).toBe(1);
    const [first, ...rest] = guard.stdout.trim().split("\n");
    expect(first).toBe(
      `::notice title=${RECEIPT_TITLE}::${receiptMessage({ number: 77, base: "release/0.7", head: "c".repeat(40) })}`,
    );
    expect(rest.join("\n")).toMatch(/::error::name the 0\.7\.x issue/);
  });
});

describe("the guard's release-preparation check", () => {
  it("reads the diff pinned to the event's base and head, never the live file list", () => {
    const [base, head] = ["b".repeat(40), "c".repeat(40)];
    const event = join(work, "release-pr.json");
    writeFileSync(
      event,
      JSON.stringify({
        pull_request: {
          number: 78,
          body: "",
          labels: [{ name: "release" }],
          milestone: null,
          base: { ref: "release/0.7", sha: base },
          head: { ref: "release/v0.7.2", sha: head, repo: { full_name: "o/r" } },
        },
      }),
    );
    const bin = join(work, "guard-bin");
    mkdirSync(bin);
    const pkg = (version) => Buffer.from(JSON.stringify({ name: "orca", version })).toString("base64");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >> "${join(work, "guard-gh.log")}"\ncase "$*" in *compare/*) printf '%s' '${JSON.stringify({
        total_commits: 1,
        files: [
          { filename: "package.json", status: "modified" },
          { filename: "CHANGELOG.md", status: "modified" },
        ],
      })}';; *contents/package.json?ref=${base}*) printf '{"content":"${pkg("0.7.1")}"}';; *contents/package.json?ref=${head}*) printf '{"content":"${pkg("0.7.2")}"}';; *) exit 1;; esac\n`,
      { mode: 0o755 },
    );
    const guard = spawnSync(process.execPath, [fileURLToPath(new URL("../release-line-guard.js", import.meta.url))], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "o/r" },
      encoding: "utf8",
    });
    expect(guard.stdout).toContain("release line check passed");
    expect(guard.status).toBe(0);
    const calls = readFileSync(join(work, "guard-gh.log"), "utf8");
    expect(calls).toContain(`repos/o/r/compare/${base}...${head}`);
    expect(calls).not.toContain("/files");
  });
});
