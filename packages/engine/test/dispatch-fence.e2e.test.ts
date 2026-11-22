/**
 * #357: an agent turn's record is the evidence that a prompt may have been sent, so it is
 * synced to durable storage before the prompt goes out; a store that cannot sync it never
 * sends one.
 */
import { rm } from "node:fs/promises";
import { parseWorkflow, WorkflowRegistry, type OrcaEvent } from "@orca/core";
import { memoryStores, type EventStore } from "@orca/store";
import { afterAll, expect, it } from "vitest";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const workflow = `
id: fence
name: Dispatch fence
version: "1"
start: start
nodes:
  start: { type: start }
  build:
    type: agent
    agent: { role: builder }
    prompt: "Write the note."
    completion: { maxAttempts: 2 }
    produces:
      - { kind: note, path: ".orca/note.md" }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: build }
  - { from: build, to: done }
`;

/** The memory store's events, recording what was synced and how many prompts had gone out by then. */
function observed(events: EventStore, sync: boolean, promptsSent: () => Promise<number>) {
  const synced: { type: string; prompts: number }[] = [];
  const store: EventStore = {
    append: (input) => events.append(input),
    ...(sync
      ? {
          synchronizeEvent: async (event: OrcaEvent) => {
            synced.push({ type: event.type, prompts: await promptsSent() });
            return events.synchronizeEvent!(event);
          },
        }
      : {}),
    read: (runId) => events.read(runId),
    readTypes: (runId, types) => events.readTypes(runId, types),
    readRange: (runId, range) => events.readRange(runId, range),
    lastSeq: (runId) => events.lastSeq(runId),
    listRuns: () => events.listRuns(),
    subscribe: (listener, filter) => events.subscribe(listener, filter),
  };
  return { store, synced };
}

async function setup(sync: boolean) {
  const workflows = new WorkflowRegistry().register(parseWorkflow(workflow, "fence.yaml"));
  const base = memoryStores();
  let prompts = async () => 0;
  const { store, synced } = observed(base.events, sync, () => prompts());
  const h = await harness(
    { kinds: { note: [{ data: { status: "done" }, body: "noted" }] } },
    { workflows, stores: { ...base, events: store } },
  );
  dirs.push(h.dir);
  prompts = async () => (await h.prompts().catch(() => [])).length;
  return { h, synced };
}

it("syncs each turn record before its prompt is sent", async () => {
  const { h, synced } = await setup(true);
  const state = await h.orchestrator.startAndRun({ workflowId: "fence" });
  expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
  const turns = synced.filter((s) => s.type === "agent.turn.started");
  expect(turns.length).toBeGreaterThan(0);
  // The n-th turn was durable while only n-1 prompts had gone out.
  turns.forEach((turn, i) => expect(turn.prompts).toBe(i));
});

it("sends no prompt through a store that cannot sync the turn record, and does not retry", async () => {
  const { h } = await setup(false);
  const state = await h.orchestrator.startAndRun({ workflowId: "fence" });
  expect(state.run.status).toBe("failed");
  expect(state.run.error?.code).toBe("NOT_SUPPORTED");
  expect(await h.prompts().catch(() => [])).toEqual([]);
  // The record was written before the sync was refused, so the step counts as dispatched and
  // waits for review instead of being retried.
  const builds = state.stepOrder.map((id) => state.steps[id]!).filter((s) => s.nodeId === "build");
  expect(builds.map((s) => [s.attempt, s.dispatched])).toEqual([[1, true]]);
});
