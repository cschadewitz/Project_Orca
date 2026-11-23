/**
 * #357 acceptance: a real interpreter process that stops (a restart, or a SIGKILL in the middle
 * of a step) leaves a run that Resume continues from where it was, in a new process, without
 * running a completed step again. The recovery preview says beforehand exactly which step runs
 * again, and a step that may have acted is only run again after an operator's review.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fileStores } from "@orca/store";
import { previewRecovery, runLeaseResource } from "../src/index.js";
import { childCommand } from "./child-command.js";
import { CRASH_WORKFLOW, crashRuntime, executions } from "./crash-resume-fixture.js";

const childEntry = new URL("./crash-resume-child.ts", import.meta.url);
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-crash-resume-"));
  directories.push(dir);
  const effectsFile = join(dir, "effects.log");
  const runId = await crashRuntime(fileStores(dir), effectsFile).startRun({ workflowId: CRASH_WORKFLOW });
  return { dir, effectsFile, runId };
}

/** Run the interpreter process to its end: its exit signal and what it printed. */
function interpreter(f: { dir: string; runId: string; effectsFile: string }, mode: string) {
  return new Promise<{ signal: NodeJS.Signals | null; code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, childCommand(childEntry, [f.dir, f.runId, f.effectsFile, mode]), {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code !== null && code !== 0 && code !== 87
        ? reject(new Error(errors || `exit ${code}`))
        : resolve({ code, signal, output }),
    );
  });
}

const killed = (end: { signal: NodeJS.Signals | null; code: number | null }) =>
  end.signal === "SIGKILL" || end.code === 87;

/** A fresh interpreter over the same store, as a restarted daemon would build. */
function reopen(f: { dir: string; effectsFile: string }) {
  const stores = fileStores(f.dir);
  return { stores, orc: crashRuntime(stores, f.effectsFile) };
}

async function shipAndFinish(orc: ReturnType<typeof crashRuntime>, runId: string) {
  const [request] = await orc.pendingInputs(runId);
  await orc.answer(request!.id, "ship", runId);
  return orc.resume(runId);
}

it("a run parked by a process that has since exited resumes in a new process without repeating any step", async () => {
  const f = await fixture();
  expect(await interpreter(f, "park")).toMatchObject({ code: 0, output: "paused" });
  expect(executions(f.effectsFile)).toEqual(["provision", "deploy"]);

  const { orc, stores } = reopen(f);
  const resume = (await previewRecovery(stores, f.runId)).options.find((o) => o.kind === "resume")!;
  expect(resume).toMatchObject({ readiness: "available", blockers: [] });
  expect(resume.runsAgain.map((s) => s.nodeId)).toEqual(["approve"]);
  const done = await shipAndFinish(orc, f.runId);
  expect(done.run.status).toBe("completed");
  expect(executions(f.effectsFile)).toEqual(["provision", "deploy"]);
});

it("a run killed between steps resumes at the step it had not started, and reruns nothing completed", async () => {
  const f = await fixture();
  expect(killed(await interpreter(f, "kill-before-deploy"))).toBe(true);
  expect(executions(f.effectsFile)).toEqual(["provision"]);

  const { orc, stores } = reopen(f);
  // The dead process's lease is still on file; the next interpreter on this host takes it over.
  expect(await stores.leases.get(runLeaseResource(f.runId))).toBeDefined();
  const resume = (await previewRecovery(stores, f.runId)).options.find((o) => o.kind === "resume")!;
  expect(resume).toMatchObject({ readiness: "available", blockers: [] });
  expect(resume.runsAgain.map((s) => [s.nodeId, s.effect])).toEqual([["deploy", "not-started"]]);

  expect((await orc.resume(f.runId)).run.status).toBe("paused");
  expect(executions(f.effectsFile)).toEqual(["provision", "deploy"]);
  expect((await shipAndFinish(orc, f.runId)).run.status).toBe("completed");
  expect(executions(f.effectsFile)).toEqual(["provision", "deploy"]);
});

it("a run killed inside a side effect is held for review, then resumes running only that step once more", async () => {
  const f = await fixture();
  expect(killed(await interpreter(f, "kill-in-deploy"))).toBe(true);
  expect(executions(f.effectsFile)).toEqual(["provision", "deploy"]);

  const { orc, stores } = reopen(f);
  const before = await stores.events.read(f.runId);
  const held = (await previewRecovery(stores, f.runId)).options.find((o) => o.kind === "resume")!;
  expect(held).toMatchObject({ readiness: "blocked", blockers: ["effect-unreviewed"] });
  expect(held.runsAgain.map((s) => s.nodeId)).toEqual(["deploy"]);
  // Resume refuses without writing anything or running anything.
  await expect(orc.resume(f.runId)).rejects.toMatchObject({ code: "EFFECT_REVIEW_REQUIRED" });
  expect(await stores.events.read(f.runId)).toEqual(before);
  expect(executions(f.effectsFile)).toEqual(["provision", "deploy"]);

  const state = await orc.getState(f.runId);
  const deploy = state.stepOrder.find((id) => state.steps[id]!.nodeId === "deploy")!;
  await orc.reviewEffect(f.runId, deploy, "run-again", { note: "the deploy never reached the target" });
  expect((await orc.resume(f.runId)).run.status).toBe("paused");
  expect(executions(f.effectsFile)).toEqual(["provision", "deploy", "deploy"]);
  expect((await shipAndFinish(orc, f.runId)).run.status).toBe("completed");
  // Provision ran once in all; history keeps the interrupted attempt beside the one that finished.
  expect(executions(f.effectsFile)).toEqual(["provision", "deploy", "deploy"]);
  const final = await orc.getState(f.runId);
  const attempts = final.stepOrder.filter((id) => final.steps[id]!.nodeId === "deploy");
  expect(attempts.map((id) => final.steps[id]!.status)).toEqual(["cancelled", "completed"]);
  expect(final.steps[deploy]!.effectReview).toMatchObject({ decision: "run-again" });
});
