/** Tests the actual append-only projection, including replay from authenticated protected execution storage. */
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OrcaError } from "@orca/core";
import { FileExecutionStore } from "@orca/store";
import {
  RunRevisionJournal,
  type RevisionJournalEntry,
  type RevisionLog,
  type RevisionRecord,
  type RevisionBoundary,
} from "../src/revision-input.js";
const stale = () => new OrcaError("RUN_STATE", "stale");
it("replays original payload, supersession and gate decision from protected records after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-revision-"));
  try {
    let store = new FileExecutionStore(dir);
    let length = 0;
    const log: RevisionLog = {
      withRun: async (_run, work) => work(), // Sequential storage fixture; production supplies the run lease.
      read: async () =>
        Promise.all(
          Array.from({ length }, (_, i) => store.getGeneration(`fixture-${i}`) as Promise<RevisionJournalEntry>),
        ),
      append: async (_run, entry) => {
        await store.putGeneration(`fixture-${length}`, entry);
        length++;
      },
      status: async (_run, boundary) => boundary.status,
    };
    const boundary: RevisionBoundary = {
      target: { runId: "r", stepRunId: "s", requestId: "q", destinationId: "d", expectedRevision: "v0" },
      capability: {
        actionId: "changes",
        destinationNodeId: "agent",
        composition: "replace-revision-slot",
        payload: { kind: "text", maxBytes: 100 },
      },
      destinationDescription: "Agent",
      attemptId: "a",
      generationId: "g",
      workflowRevision: "w",
      status: "waiting",
    };
    await log.append("r", { kind: "boundary", boundary });
    const record: RevisionRecord = {
      receipt: {
        revisionId: "one",
        target: boundary.target,
        attemptId: "a",
        currentRevisionId: "one",
        expectedRevision: "v1",
        state: "pending",
      },
      payload: { kind: "text", text: "PRIVATE-CORRECTION-CONTENT" },
      delivery: "unclaimed",
      capability: boundary.capability,
      provenance: {
        actor: { principalId: "human" },
        workspaceId: "workspace",
        operationId: "op1",
        source: "human-revision",
        recordedAt: "now",
      },
    };
    const first = new RunRevisionJournal(log, stale);
    await first.withRun("r", (tx) =>
      tx.commit({
        operationId: "op1",
        record,
        decision: { requestId: "q", stepRunId: "s", answer: "changes", actor: { principalId: "human" } },
      }),
    );
    store = new FileExecutionStore(dir);
    const restarted = new RunRevisionJournal(log, stale);
    await restarted.withRun("r", async (tx) => {
      expect(await tx.boundary("d")).toMatchObject({ status: "answered", currentRevisionId: "one" });
      expect(await tx.committed("op1")).toEqual(record.receipt);
      expect(await tx.record("one")).toEqual(record);
      await tx.commit({
        operationId: "op2",
        supersedesRevisionId: "one",
        record: {
          ...record,
          receipt: {
            ...record.receipt,
            revisionId: "two",
            currentRevisionId: "two",
            expectedRevision: "v2",
            target: { ...record.receipt.target, expectedRevision: "v1" },
          },
          payload: { kind: "text", text: "REPLACEMENT-PRIVATE" },
        },
      });
    });
    await new RunRevisionJournal(log, stale).withRun("r", async (tx) => {
      expect(await tx.record("one")).toMatchObject({ payload: record.payload, receipt: { state: "superseded" } });
      expect(await tx.record("two")).toMatchObject({ receipt: { state: "pending" } });
    });
    const files = await readdir(join(dir, "private-execution"));
    for (const name of files) {
      const content = await readFile(join(dir, "private-execution", name), "utf8");
      expect(content).not.toContain("PRIVATE-CORRECTION-CONTENT");
      expect(content).not.toContain("REPLACEMENT-PRIVATE");
    }
    expect((await log.read("r")).filter((entry) => entry.kind === "commit" && entry.change.decision)).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
