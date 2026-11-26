// Workstream bookkeeping (tools/workstreams.js, docs/WORKSTREAMS.md, #1239): the milestone a
// merge into main rides in, the weekly report of quiet workstreams, and the two workflows.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { QUIET_BRANCH_DAYS, QUIET_FLAG_DAYS, ridingMilestone, workstreamReport } from "../workstreams.js";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = (name) => parse(readFileSync(resolve(`.github/workflows/${name}`), "utf8"));

describe("the milestone a merge into main rides in", () => {
  it("is the earliest open minor, never a patch or a closed one", () => {
    const milestones = [
      { number: 40, title: "0.10.0", state: "open" },
      { number: 32, title: "0.8.1", state: "open" },
      { number: 31, title: "0.9.0", state: "open" },
      { number: 29, title: "0.8.0", state: "closed" },
    ];
    expect(ridingMilestone(milestones)).toBe(31);
    expect(ridingMilestone(milestones.filter((m) => m.number !== 31))).toBe(40);
  });

  it("is nothing when no minor is open", () => {
    expect(ridingMilestone([{ number: 32, title: "0.8.1", state: "open" }])).toBeUndefined();
    expect(ridingMilestone([])).toBeUndefined();
    expect(ridingMilestone([{ number: 3, title: "Backlog", state: "open" }])).toBeUndefined();
  });
});

describe("the weekly report", () => {
  const now = "2026-12-28T07:11:00Z";
  const daysAgo = (n) => new Date(Date.parse(now) - n * 24 * 60 * 60 * 1000).toISOString();

  it("lists quiet branches, quiet flags and open conflicts", () => {
    const body = workstreamReport({
      now,
      branches: [
        { name: "feature/claude-agent-sdk", committedAt: daysAgo(QUIET_BRANCH_DAYS + 6) },
        { name: "feature/codex-app-server", committedAt: daysAgo(2) },
      ],
      flags: [
        { name: "observer", issue: 1300, updatedAt: daysAgo(QUIET_FLAG_DAYS) },
        { name: "promotion", issue: 1301, updatedAt: daysAgo(3) },
      ],
      conflicts: [{ number: 1400, title: "Sync conflict: feature/claude-agent-sdk" }],
    });
    expect(body).toContain("Workstream report for 2026-12-28");
    expect(body).toContain("**Feature branches:** 2. **Incubating flags:** 2.");
    expect(body).toContain("- `feature/claude-agent-sdk`: last commit 20 days ago");
    expect(body).not.toContain("feature/codex-app-server`");
    expect(body).toContain("- `observer` (#1300): last activity 30 days ago");
    expect(body).not.toContain("promotion");
    expect(body).toContain("- #1400 Sync conflict: feature/claude-agent-sdk");
  });

  it("says None when everything is moving", () => {
    const body = workstreamReport({ now });
    expect(body.match(/^None\.$/gm)).toHaveLength(3);
  });
});

describe("the Milestone on merge workflow", () => {
  const wf = workflow("milestone-on-merge.yml");
  const job = wf.jobs.milestone;

  it("runs main's copy on merged pull requests into main only", () => {
    expect(wf.on).toEqual({ pull_request_target: { branches: ["main"], types: ["closed"] } });
    expect(job.if).toContain("github.event.pull_request.merged == true");
    expect(job.if).toContain("github.event.pull_request.milestone == null");
    expect(job.if).toContain("!startsWith(github.event.pull_request.head.ref, 'release-sync/')");
    const checkout = job.steps.find((s) => String(s.uses).startsWith("actions/checkout@"));
    expect(checkout.with.ref).toBe("${{ github.event.repository.default_branch }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
  });

  it("only sets a milestone, never one a person already set, and touches no labels", () => {
    expect(job.permissions).toEqual({ contents: "read", issues: "write", "pull-requests": "write" });
    const run = job.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("node tools/workstreams.js milestone");
    expect(run).toContain(".milestone.number");
    expect(run).not.toMatch(/label/i);
  });
});

describe("the Workstream report workflow", () => {
  const wf = workflow("workstream-report.yml");
  const job = wf.jobs.report;

  it("runs weekly and on demand from main, writing only its issue", () => {
    expect(wf.on.schedule).toHaveLength(1);
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.permissions).toEqual({ contents: "read", issues: "write" });
    const run = job.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("node tools/workstreams.js report");
    expect(run).toContain("--label workstream-report");
    expect(run).toContain("gh issue edit");
    expect(run).toContain("[ -f packages/core/src/features.ts ]");
  });
});
