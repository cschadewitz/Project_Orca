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
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LOG"\ncase "$1 $2" in "pr create") echo https://x/pull/9;; esac\nexit 0\n',
      { mode: 0o755 },
    );
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const run = (sha, labels, over = {}) => {
    const event = join(work, "event.json");
    writeFileSync(
      event,
      JSON.stringify({
        pull_request: { number: 1300, title: "fix: two", body: "Fixes #12", labels: labels.map((name) => ({ name })) },
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
        ...over,
      },
    });
  };
  const merged = () => {
    const sha = commit(origin, "app.txt", "one\nTWO\nthree\n", "fix: two");
    git(clone, "fetch", "-q", "origin", "main");
    return sha;
  };

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
    expect(readFileSync(join(work, "summary"), "utf8")).toContain("already exists; skipped");
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
