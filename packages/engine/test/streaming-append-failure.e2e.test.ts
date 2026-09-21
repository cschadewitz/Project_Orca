/**
 * Regression for issue #268: an `agent.update` append that rejects while a turn is
 * streaming used to be an unobserved rejection, which is a dead process - `orca serve`
 * taking down every run it drives over one run's full disk. It must now fail the step,
 * naming it, and leave the process alive to retry.
 */
import { rm } from "node:fs/promises";
import { OrcaError, parseWorkflow, WorkflowRegistry, type OrcaEvent, type OrcaEventInput } from "@orca/core";
import { memoryStores, type EventStore } from "@orca/store";
import { afterAll, describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const workflow = `
id: streaming-append
name: Streaming append failure
version: "1"
start: start
nodes:
  start: { type: start }
  build:
    type: agent
    agent: { role: builder }
    prompt: "Write the note."
    produces:
      - { kind: note, path: ".orca/note.md" }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: build }
  - { from: build, to: done }
`;

/** The store's events, with the first `agent.update` append refused as a full disk would refuse it. */
function refuseFirstUpdate(events: EventStore): { store: EventStore; refused: () => number } {
  let refusals = 0;
  const store: EventStore = {
    append: async (input: OrcaEventInput): Promise<OrcaEvent> => {
      if (input.type === "agent.update" && refusals === 0) {
        refusals++;
        throw new OrcaError("STORE_LOCK_TIMEOUT", "no space left on device");
      }
      return events.append(input);
    },
    read: (runId) => events.read(runId),
    readTypes: (runId, types) => events.readTypes(runId, types),
    readRange: (runId, range) => events.readRange(runId, range),
    lastSeq: (runId) => events.lastSeq(runId),
    listRuns: () => events.listRuns(),
    subscribe: (listener, filter) => events.subscribe(listener, filter),
  };
  return { store, refused: () => refusals };
}

describe("a store that refuses an agent.update append", () => {
  it("fails the step with STORE_WRITE, names it, and does not crash the process", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const workflows = new WorkflowRegistry();
    workflows.register(parseWorkflow(workflow, "streaming-append.yaml"));
    const base = memoryStores();
    const { store, refused } = refuseFirstUpdate(base.events);
    const h = await harness(
      {
        kinds: {
          note: [
            { data: { status: "done" }, body: "noted" },
            { data: { status: "done" }, body: "noted" },
          ],
        },
      },
      { workflows, stores: { ...base, events: store } },
    );
    dirs.push(h.dir);

    try {
      const state = await h.orchestrator.startAndRun({ workflowId: "streaming-append" });
      expect(refused()).toBe(1);

      const failures = (await store.read(state.run.id)).filter((e) => e.type === "step.failed");
      expect(failures).toHaveLength(1);
      const error = (failures[0]!.payload as { error: { code: string; message: string } }).error;
      expect(error.code).toBe("STORE_WRITE");
      // The step and the node are in the message, so a log line says which turn's output was lost.
      expect(error.message).toContain("build");
      expect(error.message).toContain((failures[0]!.payload as { stepRunId: string }).stepRunId);
      expect(error.message).toContain("no space left on device");

      // The failure travelled as a step outcome and became the run's, rather than ending
      // the process with nothing written.
      expect(state.run.status).toBe("failed");
      expect(state.run.error?.code).toBe("STORE_WRITE");

      // Let anything queued behind the failure settle before we judge the process.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
