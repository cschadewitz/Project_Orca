/** #357 phase 1: recovery eligibility and previews are read-only, honest about effects, and fail safely. */
import { describe, expect, it } from "vitest";
import type { Artifact, OrcaEventInput } from "@orca/core";
import { memoryStores, type Stores } from "@orca/store";
import { previewRecovery, runLeaseResource } from "../src/index.js";

const ws = { hostId: "local", cwd: "/tmp/w" };
type Step = { id: string; node: string; type: string; attempt?: number };

function artifact(id: string, stepRunId: string): Artifact {
  return {
    id,
    kind: "spec",
    name: id,
    mediaType: "text/markdown",
    contentHash: "0".repeat(64),
    size: 1,
    version: 1,
    producedBy: { runId: "run_1", stepRunId },
    parents: [],
    data: {},
    createdAt: "2026-11-22T00:00:00.000Z",
  };
}

/** spec (agent, done) -> review (gate, answered) -> build (agent, started then failed) -> run failed. */
async function failedRun(
  stores: Stores,
  opts: { actor?: string; stored?: boolean; buildArtifact?: boolean } = {},
): Promise<void> {
  const runId = "run_1";
  const e = (event: Omit<OrcaEventInput, "runId">) => stores.events.append({ ...event, runId } as OrcaEventInput);
  await e({
    type: "run.created",
    payload: {
      workflowId: "wf",
      workflowVersion: "1",
      workspace: ws,
      vars: {},
      ...(opts.actor ? { actor: { principalId: opts.actor } } : {}),
      ...(opts.stored === false ? {} : { workflowStored: true as const }),
      provenance: {
        configGeneration: "gen_1",
        workflow: { id: "wf", version: "1", revision: "r" },
        inputs: [],
        selections: [
          { nodeId: "spec", agent: { value: "writer", source: "role" }, host: { value: "local", source: "default" } },
          { nodeId: "build", agent: { value: "coder", source: "role" }, host: { value: "local", source: "default" } },
        ],
      },
    },
  });
  await e({ type: "run.started", payload: {} } as never);
  const steps: Step[] = [
    { id: "s_spec", node: "spec", type: "agent" },
    { id: "s_review", node: "review", type: "gate" },
    { id: "s_build", node: "build", type: "agent" },
  ];
  for (const s of steps) {
    await e({ type: "step.scheduled", payload: { stepRunId: s.id, nodeId: s.node, nodeType: s.type, attempt: 1 } });
    await e({ type: "step.started", payload: { stepRunId: s.id, inputArtifactIds: [] } });
  }
  // Completions recorded in order after the starts keep the projection simple and valid.
  await e({
    type: "step.completed",
    payload: { stepRunId: "s_spec", result: { artifactIds: ["art_spec"], data: {} } },
  });
  await e({
    type: "human.requested",
    payload: { stepRunId: "s_review", requestId: "req_1", kind: "decision", question: "Ship?", options: [] },
  } as never);
  await e({
    type: "human.answered",
    payload: { stepRunId: "s_review", requestId: "req_1", answer: "approve" },
  });
  await e({
    type: "step.completed",
    payload: { stepRunId: "s_review", result: { choice: "approve", artifactIds: [], data: {} } },
  });
  await e({
    type: "step.failed",
    payload: { stepRunId: "s_build", error: { code: "AGENT_FAILED", message: "lost connection" }, willRetry: false },
  });
  await e({ type: "run.failed", payload: { error: { code: "AGENT_FAILED", message: "lost connection" } } });
  await stores.artifacts.put(artifact("art_spec", "s_spec"), "x");
  if (opts.stored !== false)
    await stores.workflows.put({ id: "wf", version: "1", nodes: { start: { type: "start" } }, edges: [] } as never);
}

describe("previewRecovery", () => {
  it("offers a checkpoint attempt for a failed run and flags the interrupted agent as uncertain", async () => {
    const stores = memoryStores();
    await failedRun(stores);
    const before = (await stores.events.read("run_1")).length;
    const a = await previewRecovery(stores, "run_1", { currentWorkflowVersion: "2", currentConfigGeneration: "gen_2" });
    // Read-only: nothing appended.
    expect((await stores.events.read("run_1")).length).toBe(before);

    const byKind = Object.fromEntries(a.options.map((o) => [o.kind, o]));
    expect(byKind.resume).toMatchObject({ available: false, blockers: ["terminal"] });
    expect(byKind["new-run"]!.available).toBe(true);
    expect(byKind["checkpoint-attempt"]!.available).toBe(true);

    expect(a.uncertain).toEqual([
      expect.objectContaining({ nodeId: "build", effect: "uncertain", agent: "coder", status: "failed" }),
    ]);
    const afterReview = a.checkpoints.find((c) => c.nodeId === "review")!;
    expect(afterReview.eligible).toBe(true);
    expect(afterReview.reused.map((s) => [s.nodeId, s.effect, s.asksAgain])).toEqual([
      ["spec", "reused", false],
      ["review", "reused", false],
    ]);
    expect(afterReview.ranAfter).toEqual([expect.objectContaining({ nodeId: "build", effect: "uncertain" })]);
    // The best checkpoint is the latest eligible one; what it would run again is listed.
    expect(byKind["checkpoint-attempt"]!.runsAgain.map((s) => s.nodeId)).toEqual(["build"]);
    // A checkpoint after spec would ask the person again rather than reuse their approval.
    const afterSpec = a.checkpoints.find((c) => c.nodeId === "spec")!;
    expect(afterSpec.ranAfter.find((s) => s.nodeId === "review")).toMatchObject({ asksAgain: true, effect: "repeats" });
    expect(a.drift).toEqual({
      currentWorkflowVersion: "2",
      currentConfigGeneration: "gen_2",
      recordedConfigGeneration: "gen_1",
    });
  });

  it("a checkpoint is a point in history: later attempts of a node are not reused by it", async () => {
    const stores = memoryStores();
    await failedRun(stores);
    // A loop back that ran spec again (attempt 2) after review, and never completed.
    await stores.events.append({
      type: "step.scheduled",
      runId: "run_1",
      payload: { stepRunId: "s_spec2", nodeId: "spec", nodeType: "agent", attempt: 2 },
    });
    const a = await previewRecovery(stores, "run_1");
    const afterReview = a.checkpoints.find((c) => c.nodeId === "review")!;
    expect(afterReview.reused.map((s) => [s.nodeId, s.attempt])).toEqual([
      ["spec", 1],
      ["review", 1],
    ]);
    expect(afterReview.ranAfter.map((s) => [s.nodeId, s.attempt, s.effect])).toEqual([
      ["build", 1, "uncertain"],
      ["spec", 2, "not-started"],
    ]);
  });

  it("reports a missing artifact as a blocker, never as an error", async () => {
    const stores = memoryStores();
    await failedRun(stores);
    const fresh = memoryStores();
    // Copy the log without the artifact store contents.
    for (const event of await stores.events.read("run_1"))
      await fresh.events.append({ type: event.type, runId: event.runId, payload: event.payload } as OrcaEventInput);
    await fresh.workflows.put({ id: "wf", version: "1", nodes: { start: { type: "start" } }, edges: [] } as never);
    const a = await previewRecovery(fresh, "run_1");
    for (const c of a.checkpoints) {
      expect(c.eligible).toBe(false);
      expect(c.blockers).toContain("missing-artifact");
    }
    expect(a.checkpoints[0]!.reused[0]!.missingArtifactIds).toEqual(["art_spec"]);
    expect(a.options.find((o) => o.kind === "checkpoint-attempt")).toMatchObject({
      available: false,
      blockers: ["missing-artifact"],
    });
  });

  it("refuses cross-principal, unpinned and leased recovery with actionable reasons", async () => {
    const stores = memoryStores();
    await failedRun(stores, { actor: "alice", stored: false });
    await stores.leases.acquire({ resource: runLeaseResource("run_1"), holder: "other", ttlMs: 60_000 });
    const a = await previewRecovery(stores, "run_1", { principalId: "bob" });
    const checkpoint = a.options.find((o) => o.kind === "checkpoint-attempt")!;
    expect(checkpoint.available).toBe(false);
    expect(checkpoint.blockers).toEqual(expect.arrayContaining(["cross-principal", "workflow-unpinned", "leased"]));
    // The owner is not refused for being who they are.
    const owner = await previewRecovery(stores, "run_1", { principalId: "alice" });
    expect(owner.options.find((o) => o.kind === "checkpoint-attempt")!.blockers).not.toContain("cross-principal");
  });

  it("previews resume of an interrupted run as a new attempt of the step that did not finish", async () => {
    const stores = memoryStores();
    const e = (event: Omit<OrcaEventInput, "runId">) =>
      stores.events.append({ ...event, runId: "run_2" } as OrcaEventInput);
    await e({ type: "run.created", payload: { workflowId: "wf", workflowVersion: "1", workspace: ws, vars: {} } });
    await e({ type: "run.started", payload: {} } as never);
    await e({ type: "step.scheduled", payload: { stepRunId: "s_a", nodeId: "a", nodeType: "agent", attempt: 1 } });
    await e({ type: "step.started", payload: { stepRunId: "s_a", inputArtifactIds: [] } });
    // The process died here: no completion, no run end, and its lease lapsed long ago.
    await stores.leases.acquire({ resource: runLeaseResource("run_2"), holder: "gone", ttlMs: 1 });
    const a = await previewRecovery(stores, "run_2", { now: Date.now() + 60_000 });
    const resume = a.options.find((o) => o.kind === "resume")!;
    expect(resume).toMatchObject({ available: true, blockers: [] });
    expect(resume.runsAgain).toEqual([expect.objectContaining({ nodeId: "a", attempt: 1, effect: "uncertain" })]);
    expect(a.options.find((o) => o.kind === "checkpoint-attempt")!.blockers).toContain("not-terminal");
    expect(a.uncertain.map((s) => s.nodeId)).toEqual(["a"]);
  });

  it("an unknown run is RUN_NOT_FOUND", async () => {
    await expect(previewRecovery(memoryStores(), "run_nope")).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });
});
