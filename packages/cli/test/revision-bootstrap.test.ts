/** Bootstrap installs the trusted adapter on its exact stores before scheduling begins. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import type { Stores } from "@orca/store";
import { createRevisionRuntime, PausingHumanInput } from "@orca/engine";
import { bootstrap } from "../src/bootstrap.js";

it("creates the configured revision runtime once over the actual interpreter stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-revision-bootstrap-"));
  try {
    await writeFile(
      join(dir, "tiny.yaml"),
      "id: tiny\nname: Tiny\nstart: s\nnodes: {s: {type: start}, e: {type: end}}\nedges: [{from: s, to: e}]\n",
    );
    const reserveStep = vi.fn(async () => undefined);
    const forStep = vi.fn(() => ({}));
    const factory = vi.fn((_stores: Stores) => ({ reserveStep, forStep }));
    const app = await bootstrap({
      configDir: dir,
      config: parseOrcaConfig({ workflows: ["*.yaml"], templates: [] }),
      logger: silentLogger,
      revisionRuntime: factory,
    });
    expect(factory).toHaveBeenCalledExactlyOnceWith(app.orchestrator.stores);
    expect(reserveStep).not.toHaveBeenCalled();
    const run = await app.orchestrator.startAndRun({ workflowId: "tiny" });
    expect(run.run.status).toBe("completed");
    expect(reserveStep).toHaveBeenCalledTimes(2);
    expect(forStep).toHaveBeenCalledTimes(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("declares a protected boundary while the real pinned interpreter parks at a revision gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-protected-revision-bootstrap-"));
  try {
    await writeFile(
      join(dir, "revise.yaml"),
      `
id: revise
name: Revise
version: '1'
start: start
nodes:
  start: {type: start}
  gate:
    type: gate
    question: Continue?
    options: [changes, done]
    revision:
      actionId: changes
      destinationNodeId: agent
      payload: {kind: text, maxBytes: 1024}
      composition: replace-revision-slot
  agent: {type: agent, agent: worker, prompt: Original}
  end: {type: end}
edges:
  - {from: start, to: gate}
  - {from: gate, to: agent, when: "choice == 'changes'"}
  - {from: gate, to: end, when: "choice == 'done'"}
  - {from: agent, to: end}
`,
    );
    let runtime: ReturnType<typeof createRevisionRuntime> | undefined;
    const deliveryAuthority = vi.fn(async () => {
      throw new Error("No external delivery authorized in this test");
    });
    const app = await bootstrap({
      configDir: dir,
      config: parseOrcaConfig({
        workflows: ["*.yaml"],
        templates: [],
        agents: [{ id: "worker", command: process.execPath }],
      }),
      logger: silentLogger,
      humanInput: new PausingHumanInput(),
      revisionRuntime: (stores) => {
        runtime = createRevisionRuntime({ stores, authorizeExecution: deliveryAuthority });
        return runtime.runtime;
      },
    });
    const launch = await app.generations.captureLaunch({ purpose: "workflow", workflowId: "revise" });
    const runId = await launch.startRun({ actor: { principalId: "test-principal", credentialId: "test-credential" } });
    const paused = await app.orchestrator.run(runId);
    expect(paused.run.status).toBe("paused");
    const boundaries = await runtime!.readBoundaries(runId);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({
      target: { runId },
      capability: { actionId: "changes", destinationNodeId: "agent" },
      generationId: paused.run.provenance!.configGeneration,
      workflowRevision: paused.run.provenance!.workflow.revision,
      status: "waiting",
    });
    const markers = await app.orchestrator.stores.events.readTypes(runId, ["revision.recorded"]);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.executionPayloadRef).toBeDefined();
    expect(deliveryAuthority).not.toHaveBeenCalled();
    const requestId = boundaries[0]!.target.requestId;
    await expect(app.orchestrator.answer(requestId, "changes", runId)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect((await runtime!.readBoundaries(runId))[0]!.status).toBe("waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
