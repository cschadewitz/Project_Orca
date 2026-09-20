/**
 * A `.orca` store written before #220, replayed by the code that came after it.
 *
 * #220 widened two event payloads - `AgentUpdateSummary` gained `args`/`result`,
 * and `human.requested.options` stopped being `string[]` - and promised that no
 * migration would be needed for either. This is that promise, tested against the
 * thing it is about: real JSONL lines on disk, written here by hand in the old
 * shape and read back through `JsonlEventStore`, not through a fixture builder
 * that would have been updated along with the schema.
 *
 * If this file has to be edited to make it pass, the store format broke.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reduceRun, pendingHumanInputs } from "@orca/core";
import { JsonlEventStore } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const RUN_ID = "run_pre040";

/**
 * Copied from what a v0.3.0 ORCA wrote, not generated: `options` is an array of
 * strings and the `agent.update` summary stops at `status`.
 */
const OLD_LINES = [
  {
    id: "evt_0",
    seq: 0,
    runId: RUN_ID,
    at: "2026-01-02T03:04:00.000Z",
    type: "run.created",
    payload: {
      workflowId: "review",
      workflowVersion: "1",
      workspace: { hostId: "local", cwd: "/w" },
      vars: { ticket: "ORCA-1" },
    },
  },
  { id: "evt_1", seq: 1, runId: RUN_ID, at: "2026-01-02T03:04:01.000Z", type: "run.started", payload: {} },
  {
    id: "evt_2",
    seq: 2,
    runId: RUN_ID,
    at: "2026-01-02T03:04:02.000Z",
    type: "step.scheduled",
    payload: { stepRunId: "s_gate", nodeId: "approve", nodeType: "gate", attempt: 1 },
  },
  {
    id: "evt_3",
    seq: 3,
    runId: RUN_ID,
    at: "2026-01-02T03:04:03.000Z",
    type: "step.started",
    payload: { stepRunId: "s_gate", inputArtifactIds: [] },
  },
  {
    id: "evt_4",
    seq: 4,
    runId: RUN_ID,
    at: "2026-01-02T03:04:04.000Z",
    type: "agent.update",
    payload: {
      stepRunId: "s_gate",
      sessionId: "sess_1",
      update: {
        kind: "tool_call",
        toolCallId: "tc_1",
        title: "Read src/index.ts",
        toolKind: "read",
        status: "completed",
        locations: ["src/index.ts"],
      },
    },
  },
  {
    id: "evt_5",
    seq: 5,
    runId: RUN_ID,
    at: "2026-01-02T03:04:05.000Z",
    type: "human.requested",
    payload: {
      stepRunId: "s_gate",
      requestId: "hi_1",
      kind: "decision",
      question: "Ship the rollout?",
      options: ["approve", "hold"],
      context: { artifact: "art_review" },
    },
  },
  {
    id: "evt_6",
    seq: 6,
    runId: RUN_ID,
    at: "2026-01-02T03:04:06.000Z",
    type: "step.waiting",
    payload: { stepRunId: "s_gate", on: "human-input", detail: "hi_1" },
  },
  { id: "evt_7", seq: 7, runId: RUN_ID, at: "2026-01-02T03:04:07.000Z", type: "run.paused", payload: {} },
];

async function oldStore(): Promise<JsonlEventStore> {
  const dir = await mkdtemp(join(tmpdir(), "orca-old-store-"));
  dirs.push(dir);
  await mkdir(join(dir, "runs"), { recursive: true });
  await writeFile(join(dir, "runs", `${RUN_ID}.jsonl`), OLD_LINES.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return new JsonlEventStore(dir);
}

describe("a store written before v0.4.0", () => {
  it("reads every line without a migration", async () => {
    const events = await (await oldStore()).read(RUN_ID);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("reads a gate's bare string options as options that are their own ids and labels", async () => {
    const state = reduceRun(await (await oldStore()).read(RUN_ID));
    expect(state.humanInputs.hi_1?.options).toEqual([
      { id: "approve", label: "approve" },
      { id: "hold", label: "hold" },
    ]);
  });

  it("still offers that gate as a pending question, rather than failing validation", async () => {
    const state = reduceRun(await (await oldStore()).read(RUN_ID));
    const pending = pendingHumanInputs(state);
    expect(pending.map((h) => h.id)).toEqual(["hi_1"]);
    expect(pending[0]?.question).toBe("Ship the rollout?");
    // And it is still answerable with the word it was always answerable with.
    expect(pending[0]?.options.map((o) => o.id)).toContain("approve");
  });

  it("reads a tool call with no stored body as a tool call with nothing to expand", async () => {
    const events = await (await oldStore()).read(RUN_ID);
    const update = events.find((e) => e.type === "agent.update");
    if (update?.type !== "agent.update") throw new Error("the old log's agent.update did not survive the read");
    const summary = update.payload.update;
    expect(summary.title).toBe("Read src/index.ts");
    expect(summary.locations).toEqual(["src/index.ts"]);
    expect(summary.args).toBeUndefined();
    expect(summary.result).toBeUndefined();
  });

  it("replays to the same run state it always did", async () => {
    const state = reduceRun(await (await oldStore()).read(RUN_ID));
    expect(state.run.status).toBe("paused");
    expect(state.run.vars).toEqual({ ticket: "ORCA-1" });
    expect(state.steps.s_gate?.waitingOn).toBe("human-input");
    expect(state.lastSeq).toBe(7);
  });

  it("appends to an old log without rewriting what is already in it", async () => {
    const store = await oldStore();
    const appended = await store.append({
      type: "human.answered",
      runId: RUN_ID,
      payload: { stepRunId: "s_gate", requestId: "hi_1", answer: "approve" },
    });
    expect(appended.seq).toBe(8);
    const state = reduceRun(await store.read(RUN_ID));
    // The answer recorded against the old bare-string option still matches one of its ids.
    expect(state.humanInputs.hi_1?.answer).toBe("approve");
    expect(state.humanInputs.hi_1?.options.map((o) => o.id)).toContain("approve");
    expect(pendingHumanInputs(state)).toEqual([]);
  });

  it("finds the old lines through the raw-line prefilter readTypes uses", async () => {
    const found = await (await oldStore()).readTypes(RUN_ID, ["human.requested", "agent.update"]);
    expect(found.map((e) => e.type)).toEqual(["agent.update", "human.requested"]);
  });
});
