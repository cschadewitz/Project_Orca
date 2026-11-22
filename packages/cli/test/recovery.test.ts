/**
 * `orca recovery` text (#357 phase 1): every blocker in words, uncertain effects called out, nothing
 * implied run; and `orca recovery review` (phase 2), the one subcommand that writes.
 */
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  assessRecovery,
  reduceRun,
  RECOVERY_BLOCKER_TEXT,
  RECOVERY_UNVERIFIED_TEXT,
  type OrcaEventInput,
  type StepRun,
} from "@orca/core";
import { fileStores } from "@orca/store";
import { main } from "../src/main.js";
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
  // A run with provenance has a recorded generation: on file, but restoring it is a writer's check.
  expect(text).toContain("Resume: not blocked, but unverified");
  expect(text).toContain(RECOVERY_UNVERIFIED_TEXT["generation-restore"]);
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
  // The flag parses: phase 1 documented it, and the strict parser must accept it.
  expect(await main(["recovery", runId, "--checkpoint", "s", "--json", "--cwd", dir])).toBe(0);
});

it("review records the operator's decision once, and resume then runs the step again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-recovery-review-"));
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
  gate: { type: gate, question: "Ship it?", options: [ship] }
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
  // A process resumed the run and died inside a step that can act outside ORCA.
  const stores = fileStores(join(dir, ".orca"));
  const e = (event: Omit<OrcaEventInput, "runId">) => stores.events.append({ ...event, runId } as OrcaEventInput);
  await e({ type: "run.resumed", payload: {} } as never);
  await e({
    type: "step.scheduled",
    payload: { stepRunId: "s_x", nodeId: "gate", nodeType: "custom:deploy", attempt: 2 },
  });
  await e({ type: "step.started", payload: { stepRunId: "s_x", inputArtifactIds: [] } });

  const preview = ctx(dir, [runId]);
  await commands.recovery!.run(preview.context);
  expect(preview.lines.join("\n")).toContain(RECOVERY_BLOCKER_TEXT["effect-unreviewed"]);
  // Resume refuses, writing nothing, and says what to do.
  const before = (await stores.events.read(runId)).length;
  await expect(commands.resume!.run(ctx(dir, [runId]).context)).rejects.toMatchObject({
    code: "EFFECT_REVIEW_REQUIRED",
    message: expect.stringContaining(`orca recovery review ${runId} s_x`),
  });
  expect(await stores.events.read(runId)).toHaveLength(before);

  // Neither or both decisions is a usage error; nothing is written.
  await expect(commands.recovery!.run(ctx(dir, ["review", runId, "s_x"]).context)).rejects.toMatchObject({
    code: "CONFIG_INVALID",
  });
  expect(await main(["recovery", "review", runId, "s_x", "--run-again", "--abandon", "--cwd", dir])).toBe(1);
  expect(await stores.events.read(runId)).toHaveLength(before);

  const review = ctx(dir, ["review", runId, "s_x"], { "run-again": true, note: "checked the deploy log" });
  expect(await commands.recovery!.run(review.context)).toBe(0);
  expect(review.lines.join("\n")).toContain("Reviewed s_x: it may run again.");
  // The same review again is a no-op; the other decision is refused.
  expect(await commands.recovery!.run(ctx(dir, ["review", runId, "s_x"], { "run-again": true }).context)).toBe(0);
  await expect(
    commands.recovery!.run(ctx(dir, ["review", runId, "s_x"], { abandon: true }).context),
  ).rejects.toMatchObject({ code: "RUN_STATE" });
  const events = await stores.events.read(runId);
  expect(events.filter((ev) => ev.type === "step.effect.reviewed")).toHaveLength(1);
  expect(reduceRun(events).steps.s_x!.effectReview).toMatchObject({
    decision: "run-again",
    note: "checked the deploy log",
  });
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
  dispatched: true,
  ...(status === "completed" ? { result: { artifactIds: [], data: {} } } : {}),
});

it("lists options with reasons, the uncertain step, and one checkpoint in detail", () => {
  const assess = (build: StepRun) =>
    assessRecovery({
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
        steps: { s1: step("s1", "spec", "completed"), s2: build },
        stepOrder: ["s1", "s2"],
        artifacts: {},
        humanInputs: {},
        lastSeq: 0,
      },
      workflowStored: true,
      workflowReadable: true,
      executionInputsAvailable: true,
      revision: "not-recorded",
      generation: "not-recorded",
      checkpoint: "spec",
      leased: false,
      artifactPresent: () => true,
      currentWorkflowVersion: "2",
    });
  const failed = step("s2", "build", "failed");
  let text = formatRecovery(assess(failed), true).join("\n");
  expect(text).toContain("Resume: not available");
  expect(text).toContain(RECOVERY_BLOCKER_TEXT.terminal);
  // Nobody has reviewed the failed build yet, so no checkpoint may run it again.
  expect(text).toContain(
    `Checkpoint attempt: not available (after spec s1)\n  - ${RECOVERY_BLOCKER_TEXT["effect-unreviewed"]}`,
  );
  expect(text).toContain("Review before anything runs these again:\n  build attempt 1: uncertain");

  text = formatRecovery(assess({ ...failed, effectReview: { decision: "run-again", at } }), true).join("\n");
  expect(text).toContain("Checkpoint attempt: available (after spec s1)");
  expect(text).toContain("build attempt 1: did not complete and may have acted; reviewed and marked to run again");
  expect(text).not.toContain("Review before anything runs these again");
  expect(text).toContain("after spec attempt 1 (s1): available\n    Reuses:\n      spec attempt 1: reused");
  expect(text).toContain("The workflow is now at 2; recovery from history uses 1.");
  expect(text).toMatch(/^Nothing was changed\. A new run or checkpoint attempt asks every person again/m);
});

it("start begins one checkpoint attempt per retry key and follows it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-recovery-start-"));
  dirs.push(dir);
  await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: [pick.yaml]\ntemplates: []\n", "utf8");
  await writeFile(
    join(dir, "pick.yaml"),
    `
id: pick
name: pick
start: s
nodes:
  s: { type: start }
  mark: { type: set, vars: { marked: true } }
  pick: { type: decision, source: { kind: expression, expr: "vars.choice" }, options: [a] }
  done: { type: end }
edges:
  - { from: s, to: mark }
  - { from: mark, to: pick }
  - { from: pick, to: done }
`,
    "utf8",
  );
  const started = ctx(dir, ["pick"], { var: ["choice=c"] });
  expect(await commands.run!.run(started.context)).toBe(2);
  const runId = /^run (run_\S+)/m.exec(started.lines.join("\n"))![1]!;

  const first = ctx(dir, ["start", runId], { "idempotency-key": "again" });
  // The attempt takes the same failing decision again: it is followed to its end, as `run` does.
  expect(await commands.recovery!.run(first.context)).toBe(2);
  const stores = fileStores(join(dir, ".orca"));
  const runs = await stores.events.listRuns();
  const attemptId = runs.find((id) => id !== runId)!;
  const attempt = reduceRun(await stores.events.read(attemptId));
  expect(attempt.run.checkpoint).toMatchObject({ runId });
  expect(attempt.stepOrder.map((id) => [attempt.steps[id]!.nodeId, Boolean(attempt.steps[id]!.reusedFrom)])).toEqual([
    ["s", true],
    ["mark", true],
    ["pick", false],
  ]);
  // The same key again returns that attempt; nothing new is started.
  expect(await commands.recovery!.run(ctx(dir, ["start", runId], { "idempotency-key": "again" }).context)).toBe(2);
  expect(await stores.events.listRuns()).toHaveLength(runs.length);
  // A checkpoint that is not there is a usage error; nothing is written.
  await expect(
    commands.recovery!.run(ctx(dir, ["start", runId], { checkpoint: "nowhere" }).context),
  ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  expect(await stores.events.listRuns()).toHaveLength(runs.length);
  expect(await main(["recovery", "start", runId, "--checkpoint", "mark", "--quiet", "--cwd", dir])).toBe(2);
});
