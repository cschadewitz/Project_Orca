/** #357 phase 1: recovery eligibility and previews are read-only, honest about effects, and fail safely. */
import { describe, expect, it } from "vitest";
import type { Artifact, OrcaEventInput } from "@orca/core";
import { memoryStores, type Stores } from "@orca/store";
import { inlineWorkflowDefinition, previewRecovery, runLeaseResource, workflowRevision } from "../src/index.js";

const definition = { id: "wf", version: "1", nodes: { start: { type: "start" } }, edges: [] } as never;
const REVISION = workflowRevision(definition);

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
  opts: { actor?: string; stored?: boolean; revision?: string; generation?: boolean; reviewed?: boolean } = {},
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
        workflow: { id: "wf", version: "1", revision: opts.revision ?? REVISION },
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
  // An operator checked what the failed build did and marked it to run again (#357), unless a
  // test is about the review itself.
  if (opts.reviewed !== false)
    await e({ type: "step.effect.reviewed", payload: { stepRunId: "s_build", decision: "run-again" } });
  await stores.artifacts.put(artifact("art_spec", "s_spec"), "x");
  if (opts.stored !== false) await stores.workflows.put(definition);
  if (opts.generation !== false) await stores.execution.putGeneration("gen_1", { id: "gen_1" });
}

describe("previewRecovery", () => {
  it("offers a checkpoint attempt for a failed run and flags the interrupted agent as uncertain", async () => {
    const stores = memoryStores();
    await failedRun(stores, { reviewed: false });
    // Until the interrupted build is reviewed, no checkpoint may run it again.
    const unreviewed = await previewRecovery(stores, "run_1");
    expect(unreviewed.options.find((o) => o.kind === "checkpoint-attempt")).toMatchObject({
      readiness: "blocked",
      blockers: ["effect-unreviewed"],
    });
    expect(unreviewed.uncertain).toEqual([
      expect.objectContaining({ nodeId: "build", effect: "uncertain", agent: "coder", status: "failed" }),
    ]);
    await stores.events.append({
      type: "step.effect.reviewed",
      runId: "run_1",
      payload: { stepRunId: "s_build", decision: "run-again" },
    });
    const before = (await stores.events.read("run_1")).length;
    const a = await previewRecovery(stores, "run_1", { currentWorkflowVersion: "2", currentConfigGeneration: "gen_2" });
    // Read-only: nothing appended.
    expect((await stores.events.read("run_1")).length).toBe(before);

    const byKind = Object.fromEntries(a.options.map((o) => [o.kind, o]));
    expect(byKind.resume).toMatchObject({ readiness: "blocked", blockers: ["terminal"] });
    expect(byKind["new-run"]!.readiness).toBe("available");
    // The generation is on file, but only a writer can show it restores: unverified, not available.
    expect(byKind["checkpoint-attempt"]).toMatchObject({
      readiness: "unverified",
      blockers: [],
      unverified: ["generation-restore"],
    });

    // Reviewed: no longer waiting on a decision, and shown as reviewed where it runs again.
    expect(a.uncertain).toEqual([]);
    const afterReview = a.checkpoints.find((c) => c.nodeId === "review")!;
    expect(afterReview.readiness).toBe("unverified");
    expect(afterReview.reused.map((s) => [s.nodeId, s.effect, s.asksAgain])).toEqual([
      ["spec", "reused", false],
      ["review", "reused", false],
    ]);
    expect(afterReview.ranAfter).toEqual([
      expect.objectContaining({ nodeId: "build", effect: "reviewed", review: "run-again" }),
    ]);
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
      ["build", 1, "reviewed"],
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
    await fresh.workflows.put(definition);
    await fresh.execution.putGeneration("gen_1", { id: "gen_1" });
    const a = await previewRecovery(fresh, "run_1");
    for (const c of a.checkpoints) {
      expect(c.readiness).toBe("blocked");
      expect(c.blockers).toContain("missing-artifact");
    }
    expect(a.checkpoints[0]!.reused[0]!.missingArtifactIds).toEqual(["art_spec"]);
    expect(a.options.find((o) => o.kind === "checkpoint-attempt")).toMatchObject({
      readiness: "blocked",
      blockers: ["missing-artifact"],
    });
  });

  it("refuses cross-principal, unpinned and leased recovery with actionable reasons", async () => {
    const stores = memoryStores();
    await failedRun(stores, { actor: "alice", stored: false });
    await stores.leases.acquire({ resource: runLeaseResource("run_1"), holder: "other", ttlMs: 60_000 });
    const a = await previewRecovery(stores, "run_1", { principalId: "bob" });
    const checkpoint = a.options.find((o) => o.kind === "checkpoint-attempt")!;
    expect(checkpoint.readiness).toBe("blocked");
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
    const now = Date.now() + 60_000;
    const a = await previewRecovery(stores, "run_2", { now });
    let resume = a.options.find((o) => o.kind === "resume")!;
    // It may have acted and nobody has looked: resume would run it again, so it waits for review.
    expect(resume).toMatchObject({ readiness: "blocked", blockers: ["effect-unreviewed"] });
    expect(resume.runsAgain).toEqual([expect.objectContaining({ nodeId: "a", attempt: 1, effect: "uncertain" })]);
    expect(a.options.find((o) => o.kind === "checkpoint-attempt")!.blockers).toContain("not-terminal");
    expect(a.uncertain.map((s) => s.nodeId)).toEqual(["a"]);
    await e({ type: "step.effect.reviewed", payload: { stepRunId: "s_a", decision: "run-again" } });
    resume = (await previewRecovery(stores, "run_2", { now })).options.find((o) => o.kind === "resume")!;
    expect(resume).toMatchObject({ readiness: "available", blockers: [] });
    expect(resume.runsAgain).toEqual([expect.objectContaining({ nodeId: "a", effect: "reviewed" })]);
  });

  it("resume of a child checks the paused ancestor it would actually re-drive", async () => {
    const stores = memoryStores();
    const append = (runId: string, event: Omit<OrcaEventInput, "runId">) =>
      stores.events.append({ ...event, runId } as OrcaEventInput);
    // parent (paused, its fan-out step waiting on the child) -> child (paused at an agent step).
    await append("run_p", {
      type: "run.created",
      payload: { workflowId: "wf", workflowVersion: "1", workspace: ws, vars: {}, workflowStored: true },
    });
    await append("run_p", { type: "run.started", payload: {} } as never);
    await append("run_p", {
      type: "step.scheduled",
      payload: { stepRunId: "p_fan", nodeId: "fan", nodeType: "parallel", attempt: 1 },
    });
    await append("run_p", { type: "step.started", payload: { stepRunId: "p_fan", inputArtifactIds: [] } });
    await append("run_p", { type: "run.paused", payload: {} } as never);
    await append("run_c", {
      type: "run.created",
      payload: {
        workflowId: "wf::fan",
        workflowVersion: "1",
        workspace: ws,
        vars: {},
        parentRunId: "run_p",
        parentStepRunId: "p_fan",
      },
    });
    await append("run_c", { type: "run.started", payload: {} } as never);
    await append("run_c", {
      type: "step.scheduled",
      payload: { stepRunId: "c_a", nodeId: "a", nodeType: "agent", attempt: 1 },
    });
    await append("run_c", { type: "step.started", payload: { stepRunId: "c_a", inputArtifactIds: [] } });
    await append("run_c", { type: "run.paused", payload: {} } as never);

    // The parent's pinned definition is unreadable, and another process holds its lease.
    const lease = await stores.leases.acquire({ resource: runLeaseResource("run_p"), holder: "other", ttlMs: 60_000 });
    let resume = (await previewRecovery(stores, "run_c")).options.find((o) => o.kind === "resume")!;
    expect(resume).toMatchObject({ readiness: "blocked", targetRunId: "run_p" });
    expect(resume.blockers).toEqual(expect.arrayContaining(["leased", "workflow-missing"]));
    expect(resume.runsAgain.map((s) => [s.runId, s.nodeId, s.effect])).toEqual([
      ["run_p", "fan", "restarts"],
      // It paused on purpose (the run is paused on it), so it is attempted again by design.
      ["run_c", "a", "repeats"],
    ]);

    // Readable and free: available, and still targeting the parent.
    await stores.leases.release(lease);
    await stores.workflows.put(definition);
    resume = (await previewRecovery(stores, "run_c")).options.find((o) => o.kind === "resume")!;
    expect(resume).toMatchObject({ readiness: "available", blockers: [], targetRunId: "run_p" });
  });

  it("an inline child's pin is checked against the definition built from its root", async () => {
    const body = { start: "a", nodes: { a: { type: "agent" } }, edges: [] };
    const root = {
      id: "wf2",
      version: "1",
      nodes: { start: { type: "start" }, each: { type: "loop", body: { graph: body } } },
      edges: [],
    } as never;
    const inline = inlineWorkflowDefinition(root, "wf2::each");
    // The child recorded the inline definition's revision, which is not the root's.
    expect(workflowRevision(inline)).not.toBe(workflowRevision(root));
    const setup = async (stored: never) => {
      const stores = memoryStores();
      const append = (runId: string, event: Omit<OrcaEventInput, "runId">) =>
        stores.events.append({ ...event, runId } as OrcaEventInput);
      await append("run_p", {
        type: "run.created",
        payload: { workflowId: "wf2", workflowVersion: "1", workspace: ws, vars: {}, workflowStored: true },
      });
      await append("run_p", { type: "run.started", payload: {} } as never);
      await append("run_p", {
        type: "step.scheduled",
        payload: { stepRunId: "p_each", nodeId: "each", nodeType: "loop", attempt: 1 },
      });
      await append("run_p", { type: "step.started", payload: { stepRunId: "p_each", inputArtifactIds: [] } });
      await append("run_p", { type: "run.paused", payload: {} } as never);
      await append("run_c", {
        type: "run.created",
        payload: {
          workflowId: "wf2::each",
          workflowVersion: "1",
          workspace: ws,
          vars: {},
          workflowStored: true,
          parentRunId: "run_p",
          parentStepRunId: "p_each",
          provenance: {
            configGeneration: "gen_1",
            workflow: { id: "wf2::each", version: "1", revision: workflowRevision(inline) },
            inputs: [],
            selections: [],
          },
        },
      });
      await append("run_c", { type: "run.started", payload: {} } as never);
      await append("run_c", {
        type: "step.scheduled",
        payload: { stepRunId: "c_a", nodeId: "a", nodeType: "agent", attempt: 1 },
      });
      await append("run_c", { type: "step.started", payload: { stepRunId: "c_a", inputArtifactIds: [] } });
      await append("run_c", { type: "run.paused", payload: {} } as never);
      await stores.workflows.put(stored);
      await stores.execution.putGeneration("gen_1", { id: "gen_1" });
      return (await previewRecovery(stores, "run_c")).options.find((o) => o.kind === "resume")!;
    };

    // A healthy, generation-backed inline child: not blocked, only the restore is unconfirmed.
    expect(await setup(root)).toMatchObject({
      readiness: "unverified",
      blockers: [],
      unverified: ["generation-restore"],
      targetRunId: "run_p",
    });
    // A stored root that no longer holds the inline graph cannot be continued.
    const without = { id: "wf2", version: "1", nodes: { start: { type: "start" } }, edges: [] } as never;
    expect((await setup(without)).blockers).toContain("workflow-missing");
  });

  it("a changed definition revision or a missing generation blocks continuing history", async () => {
    const changed = memoryStores();
    await failedRun(changed, { revision: "an-older-revision" });
    expect(
      (await previewRecovery(changed, "run_1")).options.find((o) => o.kind === "checkpoint-attempt")!.blockers,
    ).toContain("workflow-revision-mismatch");
    const lost = memoryStores();
    await failedRun(lost, { generation: false });
    expect(
      (await previewRecovery(lost, "run_1")).options.find((o) => o.kind === "checkpoint-attempt")!.blockers,
    ).toContain("generation-missing");
  });

  it("--checkpoint names one step attempt; the option describes exactly that one", async () => {
    const stores = memoryStores();
    await failedRun(stores);
    const a = await previewRecovery(stores, "run_1", { checkpoint: "s_spec" });
    const option = a.options.find((o) => o.kind === "checkpoint-attempt")!;
    expect(option.checkpointStepRunId).toBe("s_spec");
    expect(option.runsAgain.map((s) => s.nodeId)).toEqual(["review", "build"]);
    expect((await previewRecovery(stores, "run_1", { checkpoint: "review" })).options[2]!.checkpointStepRunId).toBe(
      "s_review",
    );
    await expect(previewRecovery(stores, "run_1", { checkpoint: "nope" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("an unknown run is RUN_NOT_FOUND", async () => {
    await expect(previewRecovery(memoryStores(), "run_nope")).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });
});
