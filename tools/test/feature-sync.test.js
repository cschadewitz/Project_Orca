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

// gh: logs every call; `pr list` answers $PRS (the JSON gh returns) and every `api` call its JSON
// ($RUNS for workflow runs, $RULES for branch rules, $FEATURE_REF for the feature ref, $CHECKS for
// check runs), each through the call's real --jq filter; `issue list` answers $ISSUES.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LOG, args.join(" ") + " [token=" + process.env.GH_TOKEN + "]\\n");
const jq = (json) => {
  const i = args.indexOf("--jq");
  return i < 0 ? json : execFileSync("jq", ["-r", args[i + 1]], { input: json, encoding: "utf8" });
};
if (args[0] === "pr" && args[1] === "list") process.stdout.write(jq(process.env.PRS || "[]") + "\\n");
else if (args[0] === "api" && args[1].includes("/rules/branches/")) process.stdout.write(jq(process.env.RULES || "[]"));
else if (args[0] === "api" && args[1].includes("/rulesets/")) {
  if (!process.env.RULESET) process.exit(1);
  process.stdout.write(jq(process.env.RULESET));
}
else if (args[0] === "api" && args[1].includes("/git/ref/heads/")) process.stdout.write(jq(JSON.stringify({ object: { sha: process.env.FEATURE_REF } })));
else if (args[0] === "api" && args[1].includes("/actions/runs")) process.stdout.write(jq(process.env.RUNS || '{"workflow_runs":[]}'));
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
        ISSUES_TOKEN: "issues",
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

  // `gh pr list --json ...` for the open sync pull request.
  const prs = (sha, { cross = false, bot = true, labels = [] } = {}) =>
    JSON.stringify([
      {
        number: 12,
        headRefOid: sha,
        isCrossRepository: cross,
        author: { login: "orca-release[bot]", is_bot: bot },
        labels: labels.map((name) => ({ name })),
      },
    ]);
  // The feature branch's active rules, and the ruleset (id 7) they come from.
  const rules = (strict = true, contexts = ["check (node 24)"], app = 15368) =>
    JSON.stringify([
      { type: "pull_request", ruleset_id: 7, parameters: {} },
      {
        type: "required_status_checks",
        ruleset_id: 7,
        parameters: {
          strict_required_status_checks_policy: strict,
          required_status_checks: contexts.map((context) => ({ context, integration_id: app })),
        },
      },
    ]);
  const ruleset = (over = {}) =>
    JSON.stringify({
      id: 7,
      enforcement: "active",
      bypass_actors: [],
      rules: [{ type: "pull_request" }, { type: "required_status_checks" }],
      ...over,
    });
  const ruled = () => ({
    RULES: rules(),
    RULESET: ruleset(),
    FEATURE_REF: git(origin, "rev-parse", "refs/heads/feature/sdk"),
  });
  // A ci.yml pull_request run for #12 at `sha`, and its check runs.
  const ciRun = (sha, over = {}) =>
    JSON.stringify({
      workflow_runs: [
        {
          path: ".github/workflows/ci.yml",
          head_sha: sha,
          run_number: 7,
          status: "completed",
          conclusion: "success",
          check_suite_id: 70,
          pull_requests: [{ number: 12 }],
          ...over,
        },
      ],
    });
  const check = (name, conclusion, over = {}) => ({
    name,
    status: conclusion ? "completed" : "in_progress",
    conclusion,
    app: { slug: "github-actions" },
    check_suite: { id: 70 },
    ...over,
  });
  const checks = (...runs) => JSON.stringify({ check_runs: runs });
  const REQUIRED = "check (node 24)";

  it("merges a sync pull request only on a successful required CI job for its exact head", () => {
    run();
    const sync = git(origin, "rev-parse", "refs/heads/feature-sync/sdk");
    const PRS = prs(sync);
    const merge = `pr merge 12 --repo o/r --merge --match-head-commit ${sync}`;
    const attempt = (env) => {
      writeFileSync(log, "");
      return run({ PRS, AUTO_MERGE: "true", ...ruled(), ...env });
    };
    // Unrelated green checks are not evidence: no CI run, or a run without the required job.
    expect(attempt({ CHECKS: checks(check("classify changes", "success"), check("lint", "success")) })).not.toContain(
      merge,
    );
    expect(attempt({ RUNS: ciRun(sync), CHECKS: checks(check("classify changes", "success")) })).not.toContain(merge);
    // Queued, skipped or neutral required job, or one from another suite or app.
    expect(attempt({ RUNS: ciRun(sync, { status: "queued", conclusion: null }), CHECKS: checks() })).not.toContain(
      merge,
    );
    expect(attempt({ RUNS: ciRun(sync), CHECKS: checks(check(REQUIRED, "skipped")) })).not.toContain(merge);
    expect(attempt({ RUNS: ciRun(sync), CHECKS: checks(check(REQUIRED, "neutral")) })).not.toContain(merge);
    expect(
      attempt({ RUNS: ciRun(sync), CHECKS: checks(check(REQUIRED, "success", { check_suite: { id: 99 } })) }),
    ).not.toContain(merge);
    expect(
      attempt({ RUNS: ciRun(sync), CHECKS: checks(check(REQUIRED, "success", { app: { slug: "someone" } })) }),
    ).not.toContain(merge);
    // A run for another head or another pull request.
    expect(attempt({ RUNS: ciRun("f".repeat(40)), CHECKS: checks(check(REQUIRED, "success")) })).not.toContain(merge);
    expect(
      attempt({ RUNS: ciRun(sync, { pull_requests: [{ number: 13 }] }), CHECKS: checks(check(REQUIRED, "success")) }),
    ).not.toContain(merge);
    // Another check failed or still running.
    expect(
      attempt({ RUNS: ciRun(sync), CHECKS: checks(check(REQUIRED, "success"), check("lint", "failure")) }),
    ).not.toContain(merge);
    expect(
      attempt({ RUNS: ciRun(sync), CHECKS: checks(check(REQUIRED, "success"), check("lint", null)) }),
    ).not.toContain(merge);
    // Green, but unattended merging is off until the ruleset is in place.
    const off = attempt({
      AUTO_MERGE: "",
      RUNS: ciRun(sync),
      CHECKS: checks(check(REQUIRED, "success"), check("x", "skipped")),
    });
    expect(off).not.toContain(merge);
    expect(readFileSync(join(work, "summary"), "utf8")).toContain("unattended merging is off");
    expect(attempt({ RUNS: ciRun(sync), CHECKS: checks(check(REQUIRED, "success"), check("x", "skipped")) })).toContain(
      merge,
    );
  });

  it("merges only under a ruleset that enforces an up-to-date required check, and not after the feature moved", () => {
    run();
    const sync = git(origin, "rev-parse", "refs/heads/feature-sync/sdk");
    const merge = `pr merge 12 --repo o/r --merge --match-head-commit ${sync}`;
    const base = { PRS: prs(sync), AUTO_MERGE: "true", RUNS: ciRun(sync), CHECKS: checks(check(REQUIRED, "success")) };
    const attempt = (env) => {
      writeFileSync(log, "");
      return run({ ...base, ...ruled(), ...env });
    };
    expect(attempt({ RULES: "[]" })).not.toContain(merge);
    expect(attempt({ RULES: rules(false) })).not.toContain(merge);
    expect(attempt({ RULES: rules(true, ["lint"]) })).not.toContain(merge);
    // The check must be bound to GitHub Actions, and nobody may bypass the ruleset.
    expect(attempt({ RULES: rules(true, ["check (node 24)"], 999) })).not.toContain(merge);
    const bypass = [{ actor_id: 1, actor_type: "Integration", bypass_mode: "always" }];
    expect(attempt({ RULESET: ruleset({ bypass_actors: bypass }) })).not.toContain(merge);
    expect(attempt({ RULESET: ruleset({ enforcement: "evaluate" }) })).not.toContain(merge);
    // A bypass list the token cannot see is unverified, as is a ruleset that cannot be read.
    expect(attempt({ RULESET: ruleset({ bypass_actors: undefined }) })).not.toContain(merge);
    expect(attempt({ RULESET: "" })).not.toContain(merge);
    expect(readFileSync(join(work, "summary"), "utf8")).toContain("no active ruleset with no bypass actors");
    // The feature branch advanced after the run fetched it: the checked tree is no longer proof.
    expect(attempt({ FEATURE_REF: "b".repeat(40) })).not.toContain(merge);
    expect(readFileSync(join(work, "summary"), "utf8")).toContain("moved since sync #12 was checked");
    expect(attempt({})).toContain(merge);
  });

  it("reads a same-repository pull request's explicit false through the real filter", () => {
    run();
    const sync = git(origin, "rev-parse", "refs/heads/feature-sync/sdk");
    const env = { AUTO_MERGE: "true", RUNS: ciRun(sync), CHECKS: checks(check(REQUIRED, "success")), ...ruled() };
    expect(run({ PRS: prs(sync, { cross: false, labels: ["no-changelog", "two words"] }), ...env })).toContain(
      "pr merge 12",
    );
  });

  it("never merges a current sync head that is not exactly the bot's clean merge, and reports it", () => {
    run();
    const green = { AUTO_MERGE: "true", CHECKS: checks(check(REQUIRED, "success")), ...ruled() };
    // Someone pushed an extra commit onto the sync branch: still current, but not the merge.
    git(origin, "checkout", "-q", "feature-sync/sdk");
    const extra = commit(origin, "extra.txt", "not from main\n");
    git(origin, "checkout", "-q", "main");
    const calls = run({ PRS: prs(extra), RUNS: ciRun(extra), ...green });
    expect(calls).not.toContain("pr merge");
    expect(calls).toMatch(/pr comment 12 [\s\S]*will not merge/);
    expect(calls).toContain("pr edit 12 --repo o/r --add-label sync-conflict");
    // The same merge commit amended with other contents.
    git(origin, "checkout", "-q", "feature-sync/sdk");
    git(origin, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(origin, "sdk.txt"), "changed in the merge\n");
    git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-a", "--amend", "--no-edit");
    const amended = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "-q", "main");
    writeFileSync(log, "");
    expect(run({ PRS: prs(amended, { labels: ["sync-conflict"] }), RUNS: ciRun(amended), ...green })).not.toContain(
      "pr merge",
    );
    expect(readFileSync(join(work, "summary"), "utf8")).toContain("contents differ from the clean merge");
    // The right merge, but from a fork or not opened by a bot.
    run({ PRS: "[]", ...green });
    const sync = git(origin, "rev-parse", "refs/heads/feature-sync/sdk");
    writeFileSync(log, "");
    expect(run({ PRS: prs(sync, { cross: true }), RUNS: ciRun(sync), ...green })).not.toContain("pr merge");
    expect(run({ PRS: prs(sync, { bot: false }), RUNS: ciRun(sync), ...green })).not.toContain("pr merge");
  });

  it("reports a conflict on one sync-conflict issue and opens no pull request", () => {
    git(origin, "checkout", "-q", "feature/sdk");
    commit(origin, "app.txt", "one\nfeature\nthree\n");
    git(origin, "checkout", "-q", "main");
    commit(origin, "app.txt", "one\nmain\nthree\n");
    const calls = run();
    expect(calls).toMatch(/issue create --repo o\/r --title Sync conflict: feature\/sdk --label sync-conflict/);
    // Issues go through the workflow's own token, not the release App's.
    expect(calls).toMatch(/issue create --repo o\/r --title Sync conflict: feature\/sdk [\s\S]*?\[token=issues\]/);
    expect(calls).toMatch(/label create sync-conflict .*\[token=issues\]/);
    expect(calls).not.toContain("pr create");
    expect(git(origin, "branch", "--list", "feature-sync/*")).toBe("");
    // A second run comments on the open issue instead of opening another.
    const again = run({ ISSUES: "41" });
    expect(again).toMatch(/issue comment 41 /);
  });

  it("skips a feature branch with no history in common with main, without an issue", () => {
    git(origin, "checkout", "-q", "--orphan", "feature/old");
    git(origin, "rm", "-rqf", ".");
    commit(origin, "old.txt", "unrelated\n");
    git(origin, "checkout", "-q", "main");
    const calls = run();
    expect(calls).not.toMatch(/issue create .*feature\/old/);
    expect(calls).not.toMatch(/pr create .*feature\/old/);
    expect(readFileSync(join(work, "summary"), "utf8")).toContain("feature/old shares no history with main; skipped");
    // The other feature branch is still synced.
    expect(calls).toMatch(/pr create --repo o\/r --base feature\/sdk/);
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
