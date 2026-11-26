// The backport workflow (tools/backport.js, tools/backport.sh, .github/workflows/backport.yml):
// which lines a label asks for, what the backport says, and the git half against a real
// repository with a fake `gh`.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backportBody, backportLines } from "../backport.js";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");

describe("the backport labels and description", () => {
  it("reads each backport:X.Y label once, in version order, and nothing else", () => {
    expect(
      backportLines([
        { name: "backport:0.10" },
        "backport:0.9",
        { name: "backport:0.9" },
        { name: "release:patch" },
        { name: "backport:latest" },
      ]),
    ).toEqual(["0.9", "0.10"]);
  });

  it("names the original and every issue it fixed, so the release line guard can check them", () => {
    const body = backportBody(
      { number: 1300, title: "fix(app): no crash", body: "Fixes #12 and refs #14.\nSee #99." },
      "0.9",
    );
    expect(body).toContain("Backport of #1300 to `release/0.9`");
    expect(body).toContain("Fixes #12\nFixes #14");
    expect(body).not.toContain("#99");
    expect(body).toContain("Original: fix(app): no crash");
  });
});

describe("the workflow", () => {
  const workflow = parse(readFileSync(resolve(".github/workflows/backport.yml"), "utf8"));
  it("runs from main on merged pull requests into main, with the main-only release-bot environment", () => {
    expect(workflow.on).toEqual({ pull_request_target: { branches: ["main"], types: ["closed", "labeled"] } });
    const job = workflow.jobs.backport;
    expect(job.if).toContain("github.event.pull_request.merged == true");
    // A routine merge without a backport label never enters the release-bot environment.
    expect(job.if).toContain(
      "github.event.action == 'closed' && contains(join(github.event.pull_request.labels.*.name, ' '), 'backport:')",
    );
    expect(job.if).toContain("github.event.action == 'labeled' && startsWith(github.event.label.name, 'backport:')");
    expect(job.environment).toBe("release-bot");
    const checkout = job.steps.find((s) => String(s.uses).startsWith("actions/checkout@"));
    expect(checkout.with.ref).toBe("${{ github.event.repository.default_branch }}");
    expect(job.steps.at(-1).run).toBe("bash tools/backport.sh");
  });
});

describe("tools/backport.sh", () => {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = (cwd, file, content, message = file) => {
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  let work;
  let origin;
  let clone;
  let log;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "orca-backport-"));
    origin = join(work, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    commit(origin, "app.txt", "one\ntwo\nthree\n");
    git(origin, "branch", "release/0.9");
    git(origin, "checkout", "-q", "release/0.9");
    commit(origin, "other.txt", "line only\n");
    git(origin, "checkout", "-q", "main");
    clone = join(work, "clone");
    git(work, "clone", "-q", "--no-local", origin, clone);
    // The checkout in Actions is main, with the tools from this repository.
    mkdirSync(join(clone, "tools"));
    for (const f of ["backport.js", "backport.sh", "release-line-guard.js", "release-lane.js"])
      writeFileSync(join(clone, "tools", f), readFileSync(resolve("tools", f)));
    log = join(work, "gh.log");
    mkdirSync(join(work, "bin"));
    writeFileSync(
      join(work, "bin", "gh"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$LOG"',
        'case "$1 $2" in',
        '  "pr create") if [ -f "$FAILONCE" ]; then rm "$FAILONCE"; echo "HTTP 502" >&2; exit 1; fi',
        '    touch "$CREATED"; echo https://x/pull/9;;',
        '  "pr list") if [ -f "$CREATED" ]; then echo https://x/pull/9; fi;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const run = (sha, labels, over = {}) => {
    const event = join(work, "event.json");
    writeFileSync(
      event,
      JSON.stringify({
        pull_request: {
          number: 1300,
          title: "fix: two",
          body: "Fixes #12",
          commits: over.COMMITS ?? 1,
          labels: labels.map((name) => ({ name })),
        },
      }),
    );
    return spawnSync("bash", ["tools/backport.sh"], {
      cwd: clone,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        LOG: log,
        GH_TOKEN: "t",
        REPO: "o/r",
        ACTION: "closed",
        ADDED: "",
        NUMBER: "1300",
        TITLE: "fix: two",
        MERGE_SHA: sha,
        GITHUB_EVENT_PATH: event,
        GITHUB_STEP_SUMMARY: join(work, "summary"),
        RUNNER_TEMP: work,
        CREATED: join(work, "created"),
        FAILONCE: join(work, "fail-once"),
        ...over,
      },
    });
  };
  // A pull request branch from main, squash-merged: one commit on main with the same change.
  const merged = (extra) => {
    git(origin, "checkout", "-q", "-b", "pr");
    commit(origin, "app.txt", "one\nTWO\nthree\n", "fix: two, first try");
    commit(origin, "app.txt", "one\nTWO\nthree\n\n", "fix: two, review");
    commit(origin, "app.txt", "one\nTWO\nthree\n", "fix: two, revert blank");
    git(origin, "update-ref", "refs/pull/1300/head", "pr");
    git(origin, "checkout", "-q", "main");
    git(origin, "branch", "-q", "-D", "pr");
    writeFileSync(join(origin, "app.txt"), "one\nTWO\nthree\n");
    if (extra) writeFileSync(join(origin, "extra.txt"), extra);
    const sha = commit(origin, "app.txt", "one\nTWO\nthree\n", "fix: two (#1300)");
    git(clone, "fetch", "-q", "origin", "main");
    return sha;
  };
  const picked = (ref) =>
    git(origin, "log", "--reverse", "--format=%B", `release/0.9..${ref}`)
      .split("\n")
      .filter((l) => l.startsWith("(cherry picked from commit "));

  it("cherry-picks the merge commit onto the line and opens a pull request into it", () => {
    const sha = merged();
    const result = run(sha, ["backport:0.9", "release:patch"]);
    expect(result.status, result.stderr).toBe(0);
    const head = git(origin, "rev-parse", "refs/heads/backport/1300-0.9");
    expect(git(origin, "show", `${head}:app.txt`)).toBe("one\nTWO\nthree");
    expect(git(origin, "show", `${head}:other.txt`)).toBe("line only");
    expect(git(origin, "log", "-1", "--format=%B", head)).toContain(`cherry picked from commit ${sha}`);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("pr create --repo o/r --base release/0.9 --head backport/1300-0.9 --title [0.9] fix: two");
    expect(calls).toContain("--add-reviewer calciferschadewitz");
  });

  it("acts only on the label just added when labelled after the merge, and skips a branch that exists", () => {
    const sha = merged();
    expect(run(sha, ["backport:0.9"], { ACTION: "labeled", ADDED: "release:patch" }).stdout).toContain(
      "No backport label",
    );
    expect(run(sha, ["backport:0.9"], { ACTION: "labeled", ADDED: "backport:0.9" }).status).toBe(0);
    const again = run(sha, ["backport:0.9"]);
    expect(again.status).toBe(0);
    expect(readFileSync(join(work, "summary"), "utf8")).toContain("already has backport pull request");
  });

  it("backports every commit of a multi-commit rebase merge, not only the last", () => {
    commit(origin, "unrelated.txt", "main moved\n");
    git(origin, "checkout", "-q", "-b", "pr", "HEAD~1");
    commit(origin, "app.txt", "one\nTWO\nthree\n", "fix: two");
    commit(origin, "added.txt", "new file\n", "fix: two, part two");
    git(origin, "update-ref", "refs/pull/1300/head", "pr");
    git(origin, "checkout", "-q", "main");
    for (const c of git(origin, "rev-list", "--reverse", "main..pr").split("\n"))
      git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "cherry-pick", c);
    git(origin, "branch", "-q", "-D", "pr");
    const sha = git(origin, "rev-parse", "main");
    git(clone, "fetch", "-q", "origin", "main");
    const result = run(sha, ["backport:0.9"], { COMMITS: 2 });
    expect(result.status, result.stderr).toBe(0);
    const head = git(origin, "rev-parse", "refs/heads/backport/1300-0.9");
    expect(git(origin, "show", `${head}:app.txt`)).toBe("one\nTWO\nthree");
    expect(git(origin, "show", `${head}:added.txt`)).toBe("new file");
    expect(() => git(origin, "show", `${head}:unrelated.txt`)).toThrow();
    expect(picked(head)).toEqual([
      `(cherry picked from commit ${git(origin, "rev-parse", "main~1")})`,
      `(cherry picked from commit ${sha})`,
    ]);
  });

  it("refuses when the change on main is not the pull request's whole diff", () => {
    const result = run(merged("not in the pull request\n"), ["backport:0.9"], { COMMITS: 3 });
    expect(result.status, result.stderr).toBe(0);
    expect(git(origin, "branch", "--list", "backport/*")).toBe("");
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("pr create");
    expect(calls).toMatch(/pr comment 1300 [\s\S]*could not be established/);
    expect(calls).toContain("pr edit 1300 --repo o/r --add-label backport-conflict");
  });

  it("opens exactly one pull request when an earlier run pushed but failed to open it", () => {
    const sha = merged();
    writeFileSync(join(work, "fail-once"), "");
    expect(run(sha, ["backport:0.9"], { COMMITS: 3 }).status).not.toBe(0);
    const pushed = git(origin, "rev-parse", "refs/heads/backport/1300-0.9");
    const retry = run(sha, ["backport:0.9"], { COMMITS: 3 });
    expect(retry.status, retry.stderr).toBe(0);
    expect(git(origin, "rev-parse", "refs/heads/backport/1300-0.9")).toBe(pushed);
    expect(readFileSync(join(work, "summary"), "utf8")).toContain("exists without a pull request; opening it");
    expect(run(sha, ["backport:0.9"], { COMMITS: 3 }).status).toBe(0);
    const creates = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("pr create"));
    expect(creates).toHaveLength(2); // the failed one and the one that opened it
    expect(readFileSync(join(work, "summary"), "utf8")).toContain("already has backport pull request");
  });

  it("leaves a backport branch that is not the expected picks alone and reports it", () => {
    git(origin, "checkout", "-q", "-b", "backport/1300-0.9", "release/0.9");
    const foreign = commit(origin, "app.txt", "one\nsomething else\nthree\n", "by hand");
    git(origin, "checkout", "-q", "main");
    const result = run(merged(), ["backport:0.9"], { COMMITS: 3 });
    expect(result.status, result.stderr).toBe(0);
    expect(git(origin, "rev-parse", "refs/heads/backport/1300-0.9")).toBe(foreign);
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("pr create");
    expect(calls).toMatch(/pr comment 1300 [\s\S]*is not the expected cherry-pick/);
  });

  it("opens nothing on a conflict and says so on the original pull request", () => {
    git(origin, "checkout", "-q", "release/0.9");
    commit(origin, "app.txt", "one\nline-two\nthree\n");
    git(origin, "checkout", "-q", "main");
    const result = run(merged(), ["backport:0.9"]);
    expect(result.status, result.stderr).toBe(0);
    expect(git(origin, "branch", "--list", "backport/*")).toBe("");
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("pr create");
    expect(calls).toMatch(/pr comment 1300 [\s\S]*did not apply cleanly[\s\S]*app\.txt/);
    expect(calls).toContain("pr edit 1300 --repo o/r --add-label backport-conflict");
  });
});
