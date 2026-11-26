// The Feature sync workflow (tools/feature-sync.sh, .github/workflows/feature-sync.yml) against a
// real git origin and a fake `gh`: open a sync pull request, merge it once green, report a
// conflict on one issue, and leave a current branch alone.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");

// gh: logs every call; `pr list` answers $PRS ("<number> <head sha>" or nothing); `api` answers
// $CHECKS through jq with the call's --jq filter; `issue list` answers $ISSUES.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LOG, args.join(" ") + "\\n");
const jq = (json) => {
  const i = args.indexOf("--jq");
  return i < 0 ? json : execFileSync("jq", ["-r", args[i + 1]], { input: json, encoding: "utf8" });
};
if (args[0] === "pr" && args[1] === "list") process.stdout.write((process.env.PRS || "") + "\\n");
else if (args[0] === "api") process.stdout.write(jq(process.env.CHECKS || '{"check_runs":[]}'));
else if (args[0] === "issue" && args[1] === "list") process.stdout.write((process.env.ISSUES || "") + "\\n");
`;

describe("the workflow", () => {
  const workflow = parse(readFileSync(resolve(".github/workflows/feature-sync.yml"), "utf8"));
  it("runs from main nightly, on main pushes and on dispatch, with the main-only release-bot environment", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "schedule", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    const job = workflow.jobs.sync;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("release-bot");
    expect(job.steps.at(-1).run).toBe("bash tools/feature-sync.sh");
  });

  it("runs CI on feature branches and on pull requests into them", () => {
    const ci = parse(readFileSync(resolve(".github/workflows/ci.yml"), "utf8"));
    expect(ci.on.pull_request.branches).toContain("feature/**");
    expect(ci.on.push.branches).toContain("feature/**");
  });
});

describe("tools/feature-sync.sh", () => {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = (cwd, file, content) => {
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
    return git(cwd, "rev-parse", "HEAD");
  };
  let work;
  let origin;
  let clone;
  let log;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "orca-feature-sync-"));
    origin = join(work, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    commit(origin, "app.txt", "one\ntwo\nthree\n");
    git(origin, "checkout", "-qb", "feature/sdk");
    commit(origin, "sdk.txt", "sdk\n");
    git(origin, "checkout", "-q", "main");
    commit(origin, "main.txt", "main moved\n");
    clone = join(work, "clone");
    git(work, "clone", "-q", "--no-local", origin, clone);
    mkdirSync(join(clone, "tools"));
    writeFileSync(join(clone, "tools", "feature-sync.sh"), readFileSync(resolve("tools/feature-sync.sh")));
    log = join(work, "gh.log");
    mkdirSync(join(work, "bin"));
    writeFileSync(join(work, "bin", "gh"), FAKE_GH, { mode: 0o755 });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const run = (env = {}) => {
    const result = spawnSync("bash", ["tools/feature-sync.sh"], {
      cwd: clone,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        LOG: log,
        GH_TOKEN: "t",
        REPO: "o/r",
        GITHUB_STEP_SUMMARY: join(work, "summary"),
        ...env,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(log, "utf8");
  };

  it("merges main into a sync branch and opens one pull request into the feature branch", () => {
    const calls = run();
    const sync = git(origin, "rev-parse", "refs/heads/feature-sync/sdk");
    expect(git(origin, "show", `${sync}:main.txt`)).toBe("main moved");
    expect(git(origin, "show", `${sync}:sdk.txt`)).toBe("sdk");
    expect(git(origin, "rev-parse", "refs/heads/feature/sdk")).not.toBe(sync);
    expect(calls).toMatch(/pr create --repo o\/r --base feature\/sdk --head feature-sync\/sdk/);
  });

  it("merges an open sync pull request once its head is current and every check passed, never before", () => {
    run();
    const sync = git(origin, "rev-parse", "refs/heads/feature-sync/sdk");
    const pending = run({ PRS: `12 ${sync}`, CHECKS: JSON.stringify({ check_runs: [{ conclusion: null }] }) });
    expect(pending).not.toContain("pr merge");
    const failing = run({ PRS: `12 ${sync}`, CHECKS: JSON.stringify({ check_runs: [{ conclusion: "failure" }] }) });
    expect(failing).not.toContain("pr merge");
    const green = run({
      PRS: `12 ${sync}`,
      CHECKS: JSON.stringify({ check_runs: [{ conclusion: "success" }, { conclusion: "skipped" }] }),
    });
    expect(green).toContain(`pr merge 12 --repo o/r --merge --match-head-commit ${sync}`);
  });

  it("reports a conflict on one sync-conflict issue and opens no pull request", () => {
    git(origin, "checkout", "-q", "feature/sdk");
    commit(origin, "app.txt", "one\nfeature\nthree\n");
    git(origin, "checkout", "-q", "main");
    commit(origin, "app.txt", "one\nmain\nthree\n");
    const calls = run();
    expect(calls).toMatch(/issue create --repo o\/r --title Sync conflict: feature\/sdk --label sync-conflict/);
    expect(calls).not.toContain("pr create");
    expect(git(origin, "branch", "--list", "feature-sync/*")).toBe("");
    // A second run comments on the open issue instead of opening another.
    const again = run({ ISSUES: "41" });
    expect(again).toMatch(/issue comment 41 /);
  });

  it("leaves a feature branch that already contains main alone, and closes its conflict issue", () => {
    git(origin, "checkout", "-q", "feature/sdk");
    git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "main");
    git(origin, "checkout", "-q", "main");
    const calls = run({ ISSUES: "41" });
    expect(calls).not.toContain("pr create");
    expect(calls).toMatch(/issue close 41 --repo o\/r/);
  });
});
