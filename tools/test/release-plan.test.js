// tools/release-plan.js: what a closed milestone releases and from which line, decided before
// release-prepare.yml writes anything, through a minor's whole life: cut at rc.1, the candidate
// recorded on main, the final prepared from the same line, the next minor cut only after.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compare, nextVersion, planRelease } from "../release-plan.js";

describe("the next version for a bump", () => {
  it.each([
    ["0.8.0", "minor", "0.9.0"],
    ["0.8.0", "major", "0.9.0"],
    ["0.8.0", "patch", "0.8.1"],
    ["1.2.3", "major", "2.0.0"],
    // A candidate is finalized by its own level's bump, not skipped past.
    ["0.9.0-rc.1", "minor", "0.9.0"],
    ["0.9.0-rc.2", "patch", "0.9.0"],
    ["0.8.1-rc.1", "patch", "0.8.1"],
    ["0.8.1-rc.1", "minor", "0.9.0"],
    ["2.0.0-rc.1", "major", "2.0.0"],
    ["2.0.0-rc.1", "minor", "2.0.0"],
  ])("%s + %s is %s", (current, bump, next) => {
    expect(nextVersion(current, bump)).toBe(next);
  });
});

describe("version order", () => {
  it.each([
    ["0.9.0-rc.9", "0.9.0-rc.10"],
    ["0.9.0-rc.2", "0.9.0-rc.11"],
    ["0.9.0-rc.10", "0.9.0"],
    ["0.9.0-alpha", "0.9.0-alpha.1"],
    ["0.9.0-alpha.1", "0.9.0-alpha.beta"],
    ["0.9.0-beta.11", "0.9.0-rc.1"],
    ["0.9.0", "0.10.0-rc.1"],
  ])("puts %s before %s (SemVer precedence)", (a, b) => {
    expect(compare(a, b)).toBeLessThan(0);
    expect(compare(b, a)).toBeGreaterThan(0);
  });
});

describe("the plan", () => {
  const repo = (over = {}) => ({
    mainVersion: "0.8.0",
    lines: { 0.7: { version: "0.7.1" } },
    tags: ["v0.7.0", "v0.7.1", "v0.8.0"],
    ...over,
  });

  it("cuts a new minor's line from main for its first candidate", () => {
    expect(planRelease({ bump: "minor", pin: "0.9.0-rc.1" }, repo())).toEqual({
      version: "0.9.0-rc.1",
      base: "release/0.9",
      cut: "main",
    });
    expect(planRelease({ bump: "minor", title: "0.9.0" }, repo())).toEqual({
      version: "0.9.0",
      base: "release/0.9",
      cut: "main",
    });
    expect(planRelease({ bump: "minor" }, repo())).toEqual({ version: "0.9.0", base: "release/0.9", cut: "main" });
  });

  it("cuts a patch line from its newest final tag", () => {
    expect(planRelease({ bump: "patch", title: "0.8.1" }, repo())).toEqual({
      version: "0.8.1",
      base: "release/0.8",
      cut: "v0.8.0",
    });
  });

  it("orders a line's candidates numerically, in both directions", () => {
    const at = (version) =>
      repo({ lines: { ...repo().lines, 0.9: { version } }, tags: [...repo().tags, `v${version}`] });
    expect(planRelease({ bump: "minor", pin: "0.9.0-rc.10" }, at("0.9.0-rc.9"))).toEqual({
      version: "0.9.0-rc.10",
      base: "release/0.9",
      cut: "",
    });
    expect(() => planRelease({ bump: "minor", pin: "0.9.0-rc.9" }, at("0.9.0-rc.10"))).toThrow(
      /v0\.9\.0-rc\.9 is not after 0\.9\.0-rc\.10/,
    );
  });

  it.each([
    ["no bump and no pin", { bump: "none" }, /no release:major\/minor\/patch label/],
    ["a version already tagged", { bump: "minor", title: "0.8.0" }, /tag v0\.8\.0 already exists/],
    ["a title the labels do not give", { bump: "patch", title: "0.9.0" }, /names 0\.9\.0 but its labels give v0\.8\.1/],
    ["a patch of a line never released", { bump: "patch", title: "0.9.1" }, /no v0\.9\.\* final/],
  ])("refuses %s", (_, milestone, message) => {
    expect(() => planRelease(milestone, repo())).toThrow(message);
  });
});

describe("a minor's life through the plan, against real refs", () => {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = (cwd, version, file = "package.json") => {
    writeFileSync(
      join(cwd, file),
      file === "package.json" ? `${JSON.stringify({ name: "orca", version })}\n` : version,
    );
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `${file} ${version}`);
    return git(cwd, "rev-parse", "HEAD");
  };
  let work;
  let origin;
  let clone;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "orca-plan-"));
    origin = join(work, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    commit(origin, "0.8.0");
    git(origin, "tag", "v0.8.0");
    commit(origin, "0.9 work\n", "next.ts");
    clone = join(work, "clone");
    git(work, "clone", "-q", "--no-local", origin, clone);
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const plan = (...args) => {
    git(clone, "fetch", "-q", "--tags", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*");
    try {
      return {
        out: execFileSync("node", [join(process.cwd(), "tools/release-plan.js"), "plan", ...args], {
          cwd: clone,
          encoding: "utf8",
        }),
      };
    } catch (error) {
      return { error: String(error.stdout) };
    }
  };
  const field = (out, name) => new RegExp(`^${name}=(.*)$`, "m").exec(out)[1];

  it("cuts rc.1 from main, records it, prepares the final from the line, then allows the next minor", () => {
    // 1. Closing the 0.9.0 milestone pinned to rc.1: cut release/0.9 from main's head.
    let { out } = plan("--bump", "minor", "--pin", "0.9.0-rc.1", "--title", "0.9.0");
    expect(field(out, "version")).toBe("0.9.0-rc.1");
    expect(field(out, "cut")).toBe("main");
    expect(field(out, "from")).toBe(git(origin, "rev-parse", "main"));
    git(origin, "branch", "release/0.9", field(out, "from"));
    git(origin, "checkout", "-q", "release/0.9");
    commit(origin, "0.9.0-rc.1");
    git(origin, "tag", "v0.9.0-rc.1");
    // 2. Release (sync main) records rc.1 on main and raises its version; main moves on.
    git(origin, "checkout", "-q", "main");
    commit(origin, "0.9.0-rc.1");
    commit(origin, "0.10 work\n", "later.ts");

    // 3. The same milestone, unpinned, finalizes on the existing line: no new cut.
    ({ out } = plan("--bump", "minor", "--title", "0.9.0"));
    expect([field(out, "version"), field(out, "base"), field(out, "cut")]).toEqual(["0.9.0", "release/0.9", ""]);
    ({ out } = plan("--bump", "minor", "--title", "Ship the planner"));
    expect([field(out, "version"), field(out, "base"), field(out, "cut")]).toEqual(["0.9.0", "release/0.9", ""]);

    // 4. The next minor cannot be cut while 0.9 is still stabilizing.
    const early = plan("--bump", "minor", "--title", "0.10.0");
    expect(early.error).toMatch(/release\/0\.9 is still stabilizing \(no v0\.9\.0 yet\)/);
    expect(git(origin, "branch", "--list", "release/0.10")).toBe("");

    // 5. Once v0.9.0 is tagged on its line, it can.
    git(origin, "checkout", "-q", "release/0.9");
    commit(origin, "0.9.0");
    git(origin, "tag", "v0.9.0");
    git(origin, "checkout", "-q", "main");
    commit(origin, "0.9.0");
    ({ out } = plan("--bump", "minor", "--title", "0.10.0"));
    expect([field(out, "version"), field(out, "base"), field(out, "cut")]).toEqual(["0.10.0", "release/0.10", "main"]);
    expect(readFileSync(join(clone, ".git", "HEAD"), "utf8")).toContain("main");
  });
});
