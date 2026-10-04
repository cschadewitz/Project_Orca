/** Real encrypted journal publication keeps commands private and recognizes an uncertain prior commit. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type { OrcaEventInput } from "@orca/core";
import { FileExecutionStore, JsonlEventStore, ProtectedEventStore, executionEvents } from "@orca/store";

const directories: string[] = [];
const secret = "private-continuation-note-fixture";
const input: OrcaEventInput = {
  type: "continuation.recorded",
  runId: "run-fixture",
  payload: {
    continuationId: "ct-fixture",
    state: "accepted",
    entry: { schemaVersion: 1, command: { note: secret }, dispatch: "needed" },
  },
};
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-continuation-protection-"));
  directories.push(dir);
  const execution = new FileExecutionStore(dir);
  await execution.putInputs({
    runId: input.runId,
    workflowId: "fixture",
    workflowVersion: "1",
    vars: {},
    sensitiveNames: [],
    secrets: [secret],
  });
  return { dir, execution, events: new ProtectedEventStore(new JsonlEventStore(dir), execution) };
}
const correlation = { kind: "continuation" as const, id: "ct-fixture", revision: 0 };

it("publishes one private authoritative entry and replays it after reconstructing both stores", async () => {
  const { dir, execution, events } = await fixture();
  const options = {
    expectedSeq: -1,
    correlation,
    equivalent: (event: { payload: unknown }) => JSON.stringify(event.payload) === JSON.stringify(input.payload),
  };
  const accepted = await events.appendDurableUnique(input, options);
  expect(accepted.payload).not.toHaveProperty("entry");
  expect(await readFile(join(dir, "runs", `${input.runId}.jsonl`), "utf8")).not.toContain(secret);
  const restored = await executionEvents(await events.read(input.runId), execution);
  expect(restored[0]?.payload).toEqual(input.payload);
  const restarted = new ProtectedEventStore(new JsonlEventStore(dir), new FileExecutionStore(dir));
  expect(await restarted.appendDurableUnique(input, options)).toEqual(accepted);
  expect(await restarted.read(input.runId)).toHaveLength(1);
});

it("checks private equivalence before replaying a public receipt", async () => {
  const { events } = await fixture();
  await events.appendDurableUnique(input, { expectedSeq: -1, correlation, equivalent: () => true });
  await expect(
    events.appendDurableUnique(input, { expectedSeq: -1, correlation, equivalent: () => false }),
  ).rejects.toMatchObject({ code: "RETRY_CONFLICT" });
  expect(await events.read(input.runId)).toHaveLength(1);
});

it("refuses journal publication without the existing protected input/key boundary", async () => {
  const { dir } = await fixture();
  const events = new ProtectedEventStore(new JsonlEventStore(dir), new FileExecutionStore(dir));
  await expect(
    events.appendDurableUnique(
      { ...input, runId: "unprotected" },
      {
        expectedSeq: -1,
        correlation,
        equivalent: () => true,
      },
    ),
  ).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(await events.read("unprotected")).toHaveLength(0);
});
