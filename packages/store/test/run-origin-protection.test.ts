/** #883: a delegated run's stated origin stays inside the event store's redaction boundary. */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { OrcaEventSchema, reduceRun, type OrcaEventInput } from "@orca/core";
import { FileExecutionStore, JsonlEventStore, ProtectedEventStore, executionEvents } from "@orca/store";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

const origin = {
  workspaceId: "0b6f3c1e-4a1d-4c7e-9a52-2d6f0f8f9a11",
  runId: "run_01JD0000000000000000000000",
  stepRunId: "step_01JD0000000000000000000000",
};

async function store(secrets: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "orca-origin-protection-"));
  directories.push(dir);
  const runId = "run_01JD0000000000000000000001";
  const execution = new FileExecutionStore(dir);
  await execution.putInputs({ runId, workflowId: "wf", workflowVersion: "1", vars: {}, sensitiveNames: [], secrets });
  const events = new ProtectedEventStore(new JsonlEventStore(dir), execution);
  const created: OrcaEventInput = {
    type: "run.created",
    runId,
    payload: {
      workflowId: "wf",
      workflowVersion: "1",
      workspace: { hostId: "h", cwd: "/w" },
      vars: {},
      executionInputsStored: true,
      origin,
    },
  };
  await events.append(created);
  const restarted = new ProtectedEventStore(new JsonlEventStore(dir), new FileExecutionStore(dir));
  return { stored: await restarted.read(runId), dir };
}

it("shows a run's origin on the public projection when no secret is involved", async () => {
  const { stored } = await store(["private-token-value"]);
  expect(reduceRun(stored).run.origin).toEqual(origin);
});

it("leaves an origin a secret touched off the public projection, and keeps it privately", async () => {
  const { stored, dir } = await store([origin.stepRunId]);
  expect(JSON.stringify(stored)).not.toContain(origin.stepRunId);
  expect(reduceRun(stored).run.origin).toBeUndefined();
  const restored = reduceRun(await executionEvents(stored, new FileExecutionStore(dir)));
  expect(restored.run.origin).toEqual(origin);
});

it("refuses an origin that is not canonical ids in the event schema", () => {
  for (const bad of [
    { ...origin, workspaceId: "ws" },
    { ...origin, runId: "run-parent" },
    { ...origin, stepRunId: "s 1" },
    { ...origin, note: "x" },
  ])
    expect(
      OrcaEventSchema.safeParse({
        id: "evt_1",
        runId: "run_01JD0000000000000000000001",
        seq: 0,
        at: "2026-11-22T00:00:00.000Z",
        type: "run.created",
        payload: {
          workflowId: "wf",
          workflowVersion: "1",
          workspace: { hostId: "h", cwd: "/w" },
          vars: {},
          origin: bad,
        },
      }).success,
    ).toBe(false);
});
