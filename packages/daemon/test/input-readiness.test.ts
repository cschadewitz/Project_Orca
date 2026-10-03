/** The engine opens the request before durable declaration makes its step readable. */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseWorkflow, reduceRun, silentLogger, systemClock, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { createRevisionRuntime, Orchestrator, PausingHumanInput } from "@orca/engine";
import { executionEvents, fileStores } from "@orca/store";
import { askHumanInput, HumanInputPending } from "../../engine/src/human-input.js";
import { RunContext } from "../../engine/src/run-context.js";
import { notificationsFor } from "../src/notifications.js";
import { ReadModel } from "../src/read-model.js";

it("an input.opened read is empty until the exact declared gate emits step.waiting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-input-readiness-"));
  const stores = fileStores(dir);
  const definition = parseWorkflow(`
id: readiness
name: Readiness
version: '1'
start: gate
nodes:
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
  - {from: gate, to: agent, when: "choice == 'changes'"}
  - {from: gate, to: end, when: "choice == 'done'"}
  - {from: agent, to: end}
`);
  try {
    await stores.workflows.put(definition);
    await stores.events.append({
      runId: "run",
      type: "run.created",
      payload: {
        workflowId: definition.id,
        workflowVersion: definition.version,
        vars: {},
        workspace: { hostId: "local", cwd: dir },
        provenance: {
          configGeneration: "generation",
          workflow: { id: definition.id, version: definition.version, revision: "revision" },
          inputs: [],
          selections: [],
        },
      },
    });
    await stores.events.append({ runId: "run", type: "run.started", payload: {} });
    const rc = await RunContext.load("run", definition, {
      stores,
      clock: systemClock,
      logger: silentLogger,
      loadState: async (id) => reduceRun(await executionEvents(await stores.events.read(id), stores.execution)),
    });
    rc.lease = await stores.leases.acquire({ resource: "run:run", holder: "readiness-test" });
    try {
      await rc.emit({
        type: "step.scheduled",
        payload: { stepRunId: "gate-step", nodeId: "gate", nodeType: "gate", attempt: 1 },
      });
      await rc.emit({ type: "step.started", payload: { stepRunId: "gate-step" } });
      const orc = new Orchestrator({
        stores,
        agents: new AgentRegistry(),
        workflows: new WorkflowRegistry().register(definition),
        templates: new TemplateRegistry(),
      });
      const reads = new ReadModel({ orchestrator: orc });
      const adapter = createRevisionRuntime({ stores, authorizeExecution: async () => {} });
      let declarationEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        declarationEntered = resolve;
      });
      let releaseDeclaration!: () => void;
      const declaration = new Promise<void>((resolve) => {
        releaseDeclaration = resolve;
      });
      const done = askHumanInput({
        port: new PausingHumanInput(),
        clock: systemClock,
        runId: "run",
        stepRunId: "gate-step",
        kind: "decision",
        question: "Continue?",
        options: ["changes", "done"],
        emit: (event) => rc.emit(event),
        onRequested: async (query) => {
          declarationEntered();
          await declaration;
          await adapter.runtime.forStep(rc, rc.state.steps["gate-step"]!).declareRevision!(query);
        },
      }).catch((error: unknown) => error);
      await entered;
      const opened = (await stores.events.read("run")).at(-1)!;
      expect(opened.type).toBe("human.requested");
      expect(notificationsFor(opened, "sub")[0]!.method).toBe("input.opened");
      expect((await reads.inputsList({ runId: "run" })).inputs).toEqual([]);
      expect((await orc.getState("run")).steps["gate-step"]!.status).toBe("running");
      releaseDeclaration();
      expect(await done).toBeInstanceOf(HumanInputPending);
      const waiting = (await stores.events.read("run")).at(-1)!;
      expect(waiting.type).toBe("step.waiting");
      expect(notificationsFor(waiting, "sub")[0]).toMatchObject({
        method: "step.changed",
        params: { event: "step.waiting", stepRunId: "gate-step", waitingOn: "human-input" },
      });
      const page = await reads.inputsList({ runId: "run" });
      expect(page.waiting).toBe(1);
      expect(page.inputs).toHaveLength(1);
      expect(page.inputs[0]).toMatchObject({
        id: (opened.payload as { requestId: string }).requestId,
        runId: "run",
        stepRunId: "gate-step",
      });
      // Complete protected metadata is observable without borrowing execution ownership.
      const boundaries = await adapter.readBoundaries("run");
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0]!.target).toMatchObject({
        runId: "run",
        stepRunId: "gate-step",
        requestId: page.inputs[0]!.id,
      });
      expect(boundaries[0]!.status).toBe("waiting");
      expect((await stores.leases.get("run:run"))?.guardedId).toBe(rc.lease.guardedId);
      await rc.emit({ type: "run.paused", payload: {} });
      expect(await adapter.readBoundaries("run")).toEqual(boundaries);
      expect((await stores.leases.get("run:run"))?.guardedId).toBe(rc.lease.guardedId);
    } finally {
      await stores.leases.release(rc.lease);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
