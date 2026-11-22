/** `orca recovery` text (#357 phase 1): every blocker in words, uncertain effects called out, nothing implied run. */
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { assessRecovery, RECOVERY_BLOCKER_TEXT, type StepRun } from "@orca/core";
import { commands, type CommandContext } from "../src/commands/index.js";
import { formatRecovery } from "../src/commands/recovery.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function ctx(cwd: string, positionals: string[], flags: CommandContext["flags"] = {}) {
  const lines: string[] = [];
  const context: CommandContext = {
    cwd,
    flags: { quiet: true, ...flags },
    positionals,
    out: (l) => lines.push(l),
    err: () => {},
  };
  return { context, lines };
}

/** Every file and directory under `dir` with its size and modification time. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    out.push(`${path} ${info.isDirectory() ? "dir" : info.size} ${info.mtimeMs}`);
  }
  return out.sort();
}

it("the command reads a real store and writes nothing anywhere under the workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-recovery-"));
  dirs.push(dir);
  await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: [gated.yaml]\ntemplates: []\n", "utf8");
  await writeFile(
    join(dir, "gated.yaml"),
    `
id: gated
name: gated
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: "Ship it?", options: [ship, hold] }
  shipped: { type: end }
edges:
  - { from: s, to: gate }
  - { from: gate, to: shipped }
`,
    "utf8",
  );
  const started = ctx(dir, ["gated"]);
  expect(await commands.run!.run(started.context)).toBe(3);
  const runId = /^run (run_\S+)/m.exec(started.lines.join("\n"))![1]!;

  const before = await tree(dir);
  const preview = ctx(dir, [runId]);
  expect(await commands.recovery!.run(preview.context)).toBe(0);
  expect(await tree(dir)).toEqual(before);
  const text = preview.lines.join("\n");
  expect(text).toContain(`Recovery for run ${runId} (gated@`);
  expect(text).toContain("Resume: available");
  expect(text).toContain(
    "gate attempt 1: did not complete; it acts only inside ORCA and starts again; asks a person again",
  );
  expect(text).not.toContain("Review before anything runs these again");
  expect(text).toContain(RECOVERY_BLOCKER_TEXT["not-terminal"]);

  const json = ctx(dir, [runId], { json: true });
  expect(await commands.recovery!.run(json.context)).toBe(0);
  expect(JSON.parse(json.lines.join("\n"))).toMatchObject({ runId, status: "paused" });
  expect(await tree(dir)).toEqual(before);
  await expect(commands.recovery!.run(ctx(dir, ["run_missing"]).context)).rejects.toMatchObject({
    code: "RUN_NOT_FOUND",
  });
  expect(await tree(dir)).toEqual(before);
});

const at = "2026-11-22T00:00:00.000Z";
const step = (id: string, nodeId: string, status: StepRun["status"]): StepRun => ({
  id,
  runId: "run_1",
  nodeId,
  nodeType: "agent",
  attempt: 1,
  status,
  inputArtifactIds: [],
  childRunIds: [],
  children: [],
  skippedBranches: [],
  scheduledAt: at,
  startedAt: at,
  ...(status === "completed" ? { result: { artifactIds: [], data: {} } } : {}),
});

it("lists options with reasons, the uncertain step, and one checkpoint in detail", () => {
  const a = assessRecovery({
    state: {
      run: {
        id: "run_1",
        workflowId: "wf",
        workflowVersion: "1",
        status: "failed",
        workspace: { hostId: "h", cwd: "/" },
        vars: {},
        createdAt: at,
      },
      steps: { s1: step("s1", "spec", "completed"), s2: step("s2", "build", "failed") },
      stepOrder: ["s1", "s2"],
      artifacts: {},
      humanInputs: {},
      lastSeq: 0,
    },
    workflowStored: true,
    workflowReadable: true,
    executionInputsAvailable: true,
    leased: false,
    artifactPresent: () => true,
    currentWorkflowVersion: "2",
  });
  const text = formatRecovery(a, "spec").join("\n");
  expect(text).toContain("Resume: not available");
  expect(text).toContain(RECOVERY_BLOCKER_TEXT.terminal);
  expect(text).toContain("Checkpoint attempt: available");
  expect(text).toContain("Review before anything runs these again:\n  build attempt 1: uncertain");
  expect(text).toContain("after spec: eligible\n    Reuses:\n      spec attempt 1: reused");
  expect(text).toContain("The workflow is now at 2; recovery from history uses 1.");
  expect(text).toMatch(/^Nothing was changed\. Approvals and permissions are never carried forward/m);
});
