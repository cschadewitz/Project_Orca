import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError, parseWorkflow, reduceRun, silentLogger, systemClock } from "@orca/core";
import { executionEvents, fileStores } from "@orca/store";
import { RunContext } from "../src/run-context.js";
import { createRevisionRuntime } from "../src/revision-runtime.js";
import { RevisionInputService, type RetryClaims, type RetryContext } from "../src/revision-input.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const definition = () =>
  parseWorkflow(`
id: revise
name: Revise
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
const retries: RetryClaims = {
  execute: async (operation, command, _retry, authority) => {
    let binding: Awaited<ReturnType<RetryContext["readBinding"]>>;
    const operationId = randomUUID();
    const result = await operation.prepare(command, {
      operationId,
      readBinding: async () => binding,
      bind: async (value) => {
        binding = value;
      },
      reauthorize: () => authority.authorize(command),
    });
    return { state: "resolved", operationId, replayed: false, result };
  },
};
async function setup(values = false) {
  const dir = await mkdtemp(join(tmpdir(), "orca-revision-runtime-"));
  dirs.push(dir);
  const stores = fileStores(dir);
  const def = definition();
  if (values && def.nodes.gate?.type === "gate" && def.nodes.gate.revision)
    def.nodes.gate.revision.payload = {
      kind: "values",
      maxBytes: 1024,
      inputSchema: { fields: { secret: { type: "string", required: true } }, unknown: "reject" },
    };
  await stores.workflows.put(def);
  await stores.events.append({
    runId: "run",
    type: "run.created",
    payload: {
      workflowId: def.id,
      workflowVersion: def.version,
      vars: {},
      workspace: { hostId: "local", cwd: dir },
      provenance: {
        configGeneration: "generation",
        workflow: { id: def.id, version: def.version, revision: "revision" },
        inputs: [],
        selections: [],
      },
    },
  });
  await stores.events.append({ runId: "run", type: "run.started", payload: {} });
  const load = async (): Promise<RunContext> =>
    RunContext.load("run", def, {
      stores,
      clock: systemClock,
      logger: silentLogger,
      loadState: async (runId) => reduceRun(await executionEvents(await stores.events.read(runId), stores.execution)),
    });
  const attach = async () => {
    const rc = await load();
    rc.lease = await stores.leases.acquire({ resource: "run:run", holder: randomUUID() });
    return rc;
  };
  const authorizeExecution = vi.fn(async (_runId: string) => undefined);
  const adapter = createRevisionRuntime({ stores, authorizeExecution });
  let rc = await attach();
  await rc.emit({
    type: "step.scheduled",
    payload: { stepRunId: "gate-step", nodeId: "gate", nodeType: "gate", attempt: 1 },
  });
  await rc.emit({ type: "step.started", payload: { stepRunId: "gate-step" } });
  await rc.emit({
    type: "human.requested",
    payload: {
      stepRunId: "gate-step",
      requestId: "ask",
      kind: "decision",
      question: "Continue?",
      options: [
        { id: "changes", label: "Changes" },
        { id: "done", label: "Done" },
      ],
      context: {},
    },
  });
  const query = {
    runId: "run",
    stepRunId: "gate-step",
    requestId: "ask",
    kind: "decision" as const,
    question: "Continue?",
    options: [{ id: "changes", label: "Changes" }],
    context: {},
  };
  await adapter.runtime.forStep(rc, rc.state.steps["gate-step"]!).declareRevision!(query);
  await stores.leases.release(rc.lease!);
  const boundary = (await adapter.readBoundaries("run"))[0]!;
  const service = new RevisionInputService({
    journal: adapter.journal,
    retries,
    stale: () => new OrcaError("REVISION_STALE", "stale"),
    access: {
      principalId: "user",
      workspaceId: "workspace",
      actor: async () => ({ principalId: "user" }),
      read: async () => ({ content: true, mutate: true }),
      mutate: async () => undefined,
    },
  });
  const authority = { principalId: "user", workspaceId: "workspace", authorize: async () => undefined };
  const submit = async (text = "PRIVATE CORRECTION") => {
    const response = await service.submit(
      { target: boundary.target, actionId: "changes", payload: { kind: "text", text } },
      {},
      authority,
    );
    if (response.state !== "resolved") throw new Error("unresolved");
    return response.result;
  };
  const destination = async () => {
    rc = await attach();
    const stepId = await adapter.runtime.reserveStep(rc, "agent");
    if (!stepId) throw new Error("missing reservation");
    await rc.emit({
      type: "step.scheduled",
      payload: { stepRunId: stepId, nodeId: "agent", nodeType: "agent", attempt: 1 },
    });
    await rc.emit({ type: "step.started", payload: { stepRunId: stepId } });
    return { rc, hooks: adapter.runtime.forStep(rc, rc.state.steps[stepId]!).revisionInput!, stepId };
  };
  return {
    dir,
    stores,
    def,
    adapter,
    service,
    authority,
    submit,
    destination,
    attach,
    boundary,
    query,
    authorizeExecution,
  };
}

describe("protected revision runtime over file stores", () => {
  it("uses the actual context fence without nested lease acquisition and keeps projections current", async () => {
    const f = await setup();
    const receipt = await f.submit();
    const acquire = vi.spyOn(f.stores.leases, "acquire");
    const d = await f.destination();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(d.stepId).toBe(f.boundary.attemptId);
    const handoff = await d.hooks.claim(async (slot) => {
      expect(slot.payload).toEqual({ kind: "text", text: "PRIVATE CORRECTION" });
      return "Original";
    });
    expect(handoff.prompt).toContain("Original\n\nHuman revision");
    expect(handoff.target.revisionId).toBe(receipt.revisionId);
    await d.hooks.beforeSend(handoff);
    await d.hooks.confirm(handoff);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(d.rc.state.lastSeq).toBe(await f.stores.events.lastSeq("run"));
    expect(d.rc.publicState().lastSeq).toBe(d.rc.state.lastSeq);
    expect(f.authorizeExecution).toHaveBeenCalled();
    await f.stores.leases.release(d.rc.lease!);
  });

  it("commits one gate decision atomically and keeps correction/prompt material out of public events", async () => {
    const f = await setup();
    await f.submit();
    const events = await f.stores.events.read("run");
    expect(events.filter((e) => e.type === "human.answered")).toHaveLength(0);
    expect(events.filter((e) => e.type === "revision.recorded" && e.payload.decision)).toHaveLength(1);
    expect(reduceRun(events).humanInputs.ask?.answer).toBe("changes");
    const d = await f.destination();
    await d.hooks.claim(async () => "PRIVATE BASE");
    await d.rc.emit({ type: "vars.set", payload: { vars: { echoed: "PRIVATE CORRECTION" } } });
    expect(JSON.stringify(await f.stores.events.read("run"))).not.toContain("PRIVATE CORRECTION");
    expect(JSON.stringify(await f.stores.events.read("run"))).not.toContain("PRIVATE BASE");
    expect((await f.stores.execution.getInputs("run"))!.secrets).toContain("PRIVATE CORRECTION");
    await f.stores.leases.release(d.rc.lease!);
  });

  it("refuses parked-service mutation while the interpreter owns the run", async () => {
    const f = await setup();
    const rc = await f.attach();
    await expect(f.submit()).rejects.toMatchObject({ code: "RUN_LEASED" });
    await f.stores.leases.release(rc.lease!);
  });

  it("replaces only the pending reserved slot, never a claimed delivery", async () => {
    const f = await setup();
    const first = await f.submit();
    const target = {
      runId: "run",
      destinationId: f.boundary.target.destinationId,
      attemptId: first.attemptId,
      revisionId: first.revisionId,
    };
    const second = await f.service.replacePending(
      { target, expectedRevision: first.expectedRevision, payload: { kind: "text", text: "SECOND" } },
      {},
      f.authority,
    );
    expect(second.state).toBe("resolved");
    const d = await f.destination();
    const handoff = await d.hooks.claim(async () => "Base");
    expect(handoff.prompt).toContain("SECOND");
    expect(handoff.prompt).not.toContain("PRIVATE CORRECTION");
    await f.stores.leases.release(d.rc.lease!);
    if (second.state !== "resolved") throw new Error();
    await expect(
      f.service.replacePending(
        {
          target: { ...target, revisionId: second.result.revisionId },
          expectedRevision: second.result.expectedRevision,
          payload: { kind: "text", text: "THIRD" },
        },
        {},
        f.authority,
      ),
    ).rejects.toThrow();
  });

  it.each(["cancelled", "moved"] as const)("invalidates %s destinations before claim/send", async (kind) => {
    const f = await setup();
    await f.submit();
    const d = await f.destination();
    const handoff = await d.hooks.claim(async () => "Base");
    if (kind === "cancelled") await d.rc.emit({ type: "run.cancelled", payload: {} });
    else
      await d.rc.emit({
        type: "step.scheduled",
        payload: { stepRunId: "other", nodeId: "end", nodeType: "end", attempt: 1 },
      });
    await expect(d.hooks.beforeSend(handoff)).rejects.toMatchObject({ code: "REVISION_STALE" });
    await f.stores.leases.release(d.rc.lease!);
  });

  it("refuses replay after interruption with an already scheduled or claimed attempt", async () => {
    const f = await setup();
    await f.submit();
    const d = await f.destination();
    await d.hooks.claim(async () => "Base");
    await f.stores.leases.release(d.rc.lease!);
    const resumed = await f.attach();
    const restarted = createRevisionRuntime({ stores: fileStores(f.dir), authorizeExecution: async () => undefined });
    await expect(restarted.runtime.reserveStep(resumed, "agent")).rejects.toMatchObject({ code: "REVISION_STALE" });
    await f.stores.leases.release(resumed.lease!);
  });

  it("reserves only the exact node and rejects a fabricated handoff target", async () => {
    const f = await setup();
    await f.submit();
    const rc = await f.attach();
    expect(await f.adapter.runtime.reserveStep(rc, "end")).toBeUndefined();
    await f.stores.leases.release(rc.lease!);
    const d = await f.destination();
    const handoff = await d.hooks.claim(async () => "Base");
    expect(() => d.hooks.beforeSend({ ...handoff, target: { ...handoff.target, attemptId: "another" } })).toThrow();
    await f.stores.leases.release(d.rc.lease!);
  });

  it("rechecks live authority before send and leaves an uncertain claim non-replayable", async () => {
    const f = await setup();
    await f.submit();
    const d = await f.destination();
    const handoff = await d.hooks.claim(async () => "Base");
    f.authorizeExecution.mockRejectedValueOnce(new Error("revoked"));
    await expect(d.hooks.beforeSend(handoff)).rejects.toThrow("revoked");
    await d.hooks.uncertain(handoff);
    await expect(d.hooks.claim(async () => "Base")).rejects.toThrow();
    await f.stores.leases.release(d.rc.lease!);
  });

  it("synchronizes existing markers on read and propagates sync failures", async () => {
    const f = await setup();
    await f.submit();
    const sync = vi.spyOn(f.stores.events, "synchronizeJournal");
    await f.adapter.readBoundaries("run");
    expect(sync).toHaveBeenCalled();
    sync.mockRejectedValueOnce(new Error("sync interrupted"));
    await expect(f.adapter.readBoundaries("run")).rejects.toThrow("sync interrupted");
    sync.mockRestore();
    await expect(f.adapter.readBoundaries("run")).resolves.toHaveLength(1);
  });
  it.each(["before", "after"] as const)(
    "handles interrupted commit publication %s its marker without recreating a gate answer",
    async (point) => {
      const f = await setup();
      let binding: Awaited<ReturnType<RetryContext["readBinding"]>>;
      const context: RetryContext = {
        operationId: "stable-operation",
        readBinding: async () => binding,
        bind: async (value) => {
          binding = value;
        },
        reauthorize: async () => undefined,
      };
      const command = {
        target: f.boundary.target,
        actionId: "changes",
        payload: { kind: "text" as const, text: "INTERRUPTED SECRET" },
      };
      const original = f.stores.events.appendDurableUnique!.bind(f.stores.events);
      const append = vi.spyOn(f.stores.events, "appendDurableUnique").mockImplementationOnce(async (...args) => {
        if (point === "after") await original(...args);
        throw new Error("publication interrupted");
      });
      await expect(f.service.submitOperation.prepare(command, context)).rejects.toThrow("publication interrupted");
      append.mockRestore();
      if (point === "before") {
        await expect(f.service.submitOperation.recover(command, context)).rejects.toMatchObject({
          code: "RUN_STATE",
          details: { reason: "revision-publication-uncertain", operationId: "stable-operation" },
        });
      } else {
        const receipt = await f.service.submitOperation.recover(command, context);
        expect(receipt.revisionId).toBe(binding!.revisionId);
      }
      const events = await f.stores.events.read("run");
      expect(events.filter((event) => event.type === "revision.recorded" && event.payload.decision)).toHaveLength(
        point === "after" ? 1 : 0,
      );
      expect(JSON.stringify(events)).not.toContain("INTERRUPTED SECRET");
    },
  );

  it("never reconstructs a rewound commit from orphan private payloads", async () => {
    const f = await setup();
    const path = join(f.dir, "runs", "run.jsonl");
    const before = await readFile(path, "utf8");
    const receipt = await f.submit();
    await writeFile(path, before);
    const fresh = createRevisionRuntime({ stores: fileStores(f.dir), authorizeExecution: async () => undefined });
    await expect(fresh.journal.withRun("run", async (tx) => tx.record(receipt.revisionId))).rejects.toMatchObject({
      details: { reason: "revision-publication-uncertain" },
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rejects unknown fields in authenticated private entries instead of accepting a permissive projection", async () => {
    const f = await setup();
    const path = join(f.dir, "runs", "run.jsonl");
    const events = await executionEvents(await f.stores.events.read("run"), f.stores.execution);
    const boundary = events.find((event) => event.type === "revision.recorded")!;
    if (boundary.type !== "revision.recorded") throw new Error();
    const ref = randomUUID();
    await f.stores.execution.putPayload(ref, {
      ...boundary,
      payload: { ...boundary.payload, entry: { ...boundary.payload.entry, unexpected: true } },
    });
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    lines[boundary.seq] = JSON.stringify({ ...JSON.parse(lines[boundary.seq]!), executionPayloadRef: ref });
    await writeFile(path, `${lines.join("\n")}\n`);
    await expect(f.adapter.readBoundaries("run")).rejects.toThrow();
  });

  it("refuses delivery when the real run lease has been replaced", async () => {
    const f = await setup();
    await f.submit();
    const d = await f.destination();
    await f.stores.leases.forceRelease("run:run");
    const replacement = await f.stores.leases.acquire({ resource: "run:run", holder: "new-owner" });
    await expect(d.hooks.claim(async () => "Base")).rejects.toMatchObject({ code: "RUN_LEASED" });
    await f.stores.leases.release(replacement);
  });
  it("keeps values solely in the reserved revision slot without altering the base prompt or run vars", async () => {
    const f = await setup(true);
    await f.service.submit(
      { target: f.boundary.target, actionId: "changes", payload: { kind: "values", values: { secret: "SLOT-ONLY" } } },
      {},
      f.authority,
    );
    const d = await f.destination();
    const handoff = await d.hooks.claim(async (slot) => {
      expect(slot.payload).toEqual({ kind: "values", values: { secret: "SLOT-ONLY" } });
      expect(d.rc.state.run.vars).toEqual({});
      return "Original prompt";
    });
    expect(handoff.prompt).toBe("Original prompt");
    expect(d.rc.state.run.vars).toEqual({});
    await f.stores.leases.release(d.rc.lease!);
  });

  it("reuses the original declaration after restart, including its exact future attempt", async () => {
    const f = await setup();
    const rc = await f.attach();
    const restarted = createRevisionRuntime({ stores: fileStores(f.dir), authorizeExecution: async () => undefined });
    const count = await f.stores.events.lastSeq("run");
    await restarted.runtime.forStep(rc, rc.state.steps["gate-step"]!).declareRevision!(f.query);
    expect(await f.stores.events.lastSeq("run")).toBe(count);
    await f.stores.leases.release(rc.lease!);
    expect((await restarted.readBoundaries("run"))[0]!.attemptId).toBe(f.boundary.attemptId);
  });

  it("refuses ordinary gate answers before revision acceptance", async () => {
    const f = await setup();
    const rc = await f.attach();
    await rc.emit({ type: "human.answered", payload: { requestId: "ask", stepRunId: "gate-step", answer: "changes" } });
    await f.stores.leases.release(rc.lease!);
    await expect(f.submit()).rejects.toMatchObject({ code: "REVISION_STALE" });
    expect((await f.adapter.readBoundaries("run"))[0]!.status).toBe("moved");
  });
  it("does not return or replay a handoff when publication succeeded but the claim response was lost", async () => {
    const f = await setup();
    await f.submit();
    const d = await f.destination();
    const original = f.stores.events.appendDurableUnique!.bind(f.stores.events);
    const append = vi.spyOn(f.stores.events, "appendDurableUnique").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("claim response lost");
    });
    await expect(d.hooks.claim(async () => "Base")).rejects.toThrow("claim response lost");
    append.mockRestore();
    await expect(d.hooks.claim(async () => "Another prompt")).rejects.toMatchObject({ code: "REVISION_STALE" });
    const entries = await executionEvents(
      await f.stores.events.readTypes("run", ["revision.recorded"]),
      f.stores.execution,
    );
    expect(
      entries.filter(
        (event) => event.type === "revision.recorded" && JSON.stringify(event.payload.entry).includes('"claimed"'),
      ),
    ).toHaveLength(1);
    await f.stores.leases.release(d.rc.lease!);
  });
  it.each(["before", "after"] as const)(
    "recovers only when interruption %s guard durability left no attempt evidence",
    async (point) => {
      const f = await setup();
      let binding: Awaited<ReturnType<RetryContext["readBinding"]>>;
      const context: RetryContext = {
        operationId: "guard-operation",
        readBinding: async () => binding,
        bind: async (value) => {
          binding = value;
        },
        reauthorize: async () => undefined,
      };
      const command = {
        target: f.boundary.target,
        actionId: "changes",
        payload: { kind: "text" as const, text: "GUARDED SECRET" },
      };
      const original = f.stores.execution.putGeneration.bind(f.stores.execution);
      let guardId = "";
      const guard = vi.spyOn(f.stores.execution, "putGeneration").mockImplementationOnce(async (id, value) => {
        guardId = id;
        expect(JSON.stringify(value)).not.toContain("GUARDED SECRET");
        expect(JSON.stringify(value)).not.toContain("revisionId");
        if (point === "after") await original(id, value);
        throw new Error("guard interrupted");
      });
      await expect(f.service.submitOperation.prepare(command, context)).rejects.toThrow("guard interrupted");
      guard.mockRestore();
      expect(binding).toBeDefined();
      if (point === "before") {
        expect(await f.stores.execution.getGeneration(guardId)).toBeUndefined();
        expect((await f.service.submitOperation.recover(command, context)).revisionId).toBe(binding!.revisionId);
      } else {
        expect(await f.stores.execution.getGeneration(guardId)).toBeDefined();
        await expect(f.service.submitOperation.recover(command, context)).rejects.toMatchObject({
          details: { reason: "revision-publication-uncertain", operationId: "guard-operation" },
        });
        expect(reduceRun(await f.stores.events.read("run")).humanInputs.ask?.answer).toBeUndefined();
      }
    },
  );

  it("refuses bound recovery after marker rewind without treating the guard as acceptance", async () => {
    const f = await setup();
    const path = join(f.dir, "runs", "run.jsonl");
    const before = await readFile(path, "utf8");
    let binding: Awaited<ReturnType<RetryContext["readBinding"]>>;
    const context: RetryContext = {
      operationId: "rewound-operation",
      readBinding: async () => binding,
      bind: async (value) => {
        binding = value;
      },
      reauthorize: async () => undefined,
    };
    const command = {
      target: f.boundary.target,
      actionId: "changes",
      payload: { kind: "text" as const, text: "SECRET" },
    };
    await f.service.submitOperation.prepare(command, context);
    await writeFile(path, before);
    await expect(f.service.submitOperation.recover(command, context)).rejects.toMatchObject({
      details: { reason: "revision-publication-uncertain", operationId: "rewound-operation" },
    });
    expect(await readFile(path, "utf8")).toBe(before);
    // Changing the retry key/operation must not bypass the surviving boundary-version guard.
    await expect(f.submit("NEW OPERATION")).rejects.toMatchObject({
      details: {
        reason: "revision-publication-uncertain",
        operationId: "rewound-operation",
      },
    });
    expect(await readFile(path, "utf8")).toBe(before);
    await expect(
      f.adapter.journal.withRun("run", async (tx) => tx.committed("rewound-operation")),
    ).rejects.toMatchObject({
      details: { reason: "revision-publication-uncertain", operationId: "rewound-operation" },
    });
  });

  it("rejects declaration reallocation after its marker alone is removed", async () => {
    const f = await setup();
    const path = join(f.dir, "runs", "run.jsonl");
    const events = await f.stores.events.read("run");
    const marker = events.find((event) => event.type === "revision.recorded")!;
    await writeFile(path, (await readFile(path, "utf8")).split("\n").slice(0, marker.seq).join("\n") + "\n");
    const rc = await f.attach();
    await expect(
      f.adapter.runtime.forStep(rc, rc.state.steps["gate-step"]!).declareRevision!(f.query),
    ).rejects.toMatchObject({ details: { reason: "revision-publication-uncertain" } });
    expect(await f.stores.events.readTypes("run", ["revision.recorded"])).toHaveLength(0);
    await f.stores.leases.release(rc.lease!);
  });

  it("does not redispatch when scheduling and claim markers are rewound but their attempt guard survives", async () => {
    const f = await setup();
    await f.submit();
    const path = join(f.dir, "runs", "run.jsonl");
    const before = await readFile(path, "utf8");
    const first = await f.destination();
    await first.hooks.claim(async () => "First prompt");
    await f.stores.leases.release(first.rc.lease!);
    await writeFile(path, before);
    const second = await f.attach();
    await expect(f.adapter.runtime.reserveStep(second, "agent")).rejects.toMatchObject({
      details: { reason: "revision-publication-uncertain" },
    });
    await f.stores.leases.release(second.lease!);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("holds concurrent guard-present recovery uncertain without appending another answer", async () => {
    const f = await setup();
    let binding: Awaited<ReturnType<RetryContext["readBinding"]>>;
    const context: RetryContext = {
      operationId: "concurrent-operation",
      readBinding: async () => binding,
      bind: async (value) => {
        binding = value;
      },
      reauthorize: async () => undefined,
    };
    const command = {
      target: f.boundary.target,
      actionId: "changes",
      payload: { kind: "text" as const, text: "SECRET" },
    };
    const append = vi.spyOn(f.stores.events, "appendDurableUnique").mockRejectedValueOnce(new Error("append failed"));
    await expect(f.service.submitOperation.prepare(command, context)).rejects.toThrow("append failed");
    append.mockRestore();
    const outcomes = await Promise.allSettled([
      f.service.submitOperation.recover(command, context),
      f.service.submitOperation.recover(command, context),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(
      (await f.stores.events.read("run")).filter(
        (event) => event.type === "revision.recorded" && event.payload.decision,
      ),
    ).toHaveLength(0);
  });

  it("requires successful existing-marker synchronization after a lost append response", async () => {
    const f = await setup();
    let binding: Awaited<ReturnType<RetryContext["readBinding"]>>;
    const context: RetryContext = {
      operationId: "sync-operation",
      readBinding: async () => binding,
      bind: async (value) => {
        binding = value;
      },
      reauthorize: async () => undefined,
    };
    const command = {
      target: f.boundary.target,
      actionId: "changes",
      payload: { kind: "text" as const, text: "SECRET" },
    };
    const original = f.stores.events.appendDurableUnique!.bind(f.stores.events);
    const append = vi.spyOn(f.stores.events, "appendDurableUnique").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("response lost");
    });
    await expect(f.service.submitOperation.prepare(command, context)).rejects.toThrow("response lost");
    append.mockRestore();
    const syncOriginal = f.stores.events.synchronizeJournal!.bind(f.stores.events);
    const sync = vi.spyOn(f.stores.events, "synchronizeJournal").mockImplementation(async (runId, correlation) => {
      if (correlation.id !== (await f.stores.events.readTypes("run", ["revision.recorded"]))[0]!.journal!.id)
        throw new Error("fsync failed");
      await syncOriginal(runId, correlation);
    });
    await expect(f.service.submitOperation.recover(command, context)).rejects.toThrow("fsync failed");
    sync.mockRestore();
    expect((await f.service.submitOperation.recover(command, context)).revisionId).toBe(binding!.revisionId);
    expect(
      (await f.stores.events.read("run")).filter(
        (event) => event.type === "revision.recorded" && event.payload.decision,
      ),
    ).toHaveLength(1);
  });
  it.each(["v2", "v1"] as const)(
    "refuses pending reads, replacement, reservation and delivery after confirmed delivery rewind with %s evidence",
    async (format) => {
      const f = await setup();
      const receipt = await f.submit();
      const target = {
        runId: "run",
        destinationId: f.boundary.target.destinationId,
        attemptId: receipt.attemptId,
        revisionId: receipt.revisionId,
      };
      const path = join(f.dir, "runs", "run.jsonl");
      const before = await readFile(path, "utf8");
      const first = await f.destination();
      const handoff = await first.hooks.claim(async () => "First prompt");
      await first.hooks.beforeSend(handoff);
      await first.hooks.confirm(handoff);
      await f.stores.leases.release(first.rc.lease!);
      if (format === "v1") {
        const address = (parts: string[]) =>
          `revision-publication:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
        const shared = address(["run", "boundary-version", target.destinationId, receipt.expectedRevision]);
        const existing = (await f.stores.execution.getGeneration(shared)) as {
          operationId: string;
          correlation: unknown;
        };
        await f.stores.execution.putGeneration(
          address(["run", "transition", receipt.revisionId, receipt.expectedRevision]),
          {
            version: 1,
            kind: "revision-publication-guard",
            runId: "run",
            operationId: existing.operationId,
            correlation: existing.correlation,
          },
        );
        await rm(join(f.dir, "private-execution", `${encodeURIComponent(shared)}.generation.json`));
      }
      expect((await f.service.readPending(target)).state).toBe("delivered");
      await writeFile(path, before);
      const uncertain = { code: "RUN_STATE", details: { reason: "revision-publication-uncertain" } };
      await expect(f.service.readPending(target)).rejects.toMatchObject(uncertain);
      await expect(
        f.service.replacePending(
          { target, expectedRevision: receipt.expectedRevision, payload: { kind: "text", text: "R2 AFTER REWIND" } },
          {},
          f.authority,
        ),
      ).rejects.toMatchObject(uncertain);
      const resumed = await f.attach();
      await expect(f.adapter.runtime.reserveStep(resumed, "agent")).rejects.toMatchObject(uncertain);
      await f.stores.leases.release(resumed.lease!);
      // Previously returned hooks also fail closed under a newly acquired actual run fence.
      first.rc.lease = await f.stores.leases.acquire({ resource: "run:run", holder: randomUUID() });
      await expect(first.hooks.claim(async () => "Replayed prompt")).rejects.toMatchObject(uncertain);
      await expect(first.hooks.beforeSend(handoff)).rejects.toMatchObject(uncertain);
      await f.stores.leases.release(first.rc.lease);
      expect(await readFile(path, "utf8")).toBe(before);
    },
  );
  it("rejects an already-laundered replacement marker that conflicts with a prior delivery guard", async () => {
    const f = await setup();
    const receipt = await f.submit();
    const target = {
      runId: "run",
      destinationId: f.boundary.target.destinationId,
      attemptId: receipt.attemptId,
      revisionId: receipt.revisionId,
    };
    const path = join(f.dir, "runs", "run.jsonl");
    const before = await readFile(path, "utf8");
    const original = await f.adapter.journal.withRun("run", (tx) => tx.record(receipt.revisionId));
    if (!original) throw new Error("missing original");
    const destination = await f.destination();
    const handoff = await destination.hooks.claim(async () => "First prompt");
    await destination.hooks.beforeSend(handoff);
    await destination.hooks.confirm(handoff);
    await f.stores.leases.release(destination.rc.lease!);
    await writeFile(path, before);
    // Construct the valid but unsafe R2 marker that the old implementation could
    // publish after this rewind. The surviving R1 guard must invalidate this history.
    const operationId = randomUUID();
    const revisionId = randomUUID();
    const record = {
      ...original,
      provenance: { ...original.provenance, operationId },
      supersedesRevisionId: receipt.revisionId,
      receipt: {
        ...receipt,
        target: { ...receipt.target, expectedRevision: receipt.expectedRevision },
        revisionId,
        currentRevisionId: revisionId,
        expectedRevision: randomUUID(),
      },
      payload: { kind: "text" as const, text: "LAUNDERED R2" },
    };
    const correlation = {
      kind: "revision" as const,
      id: createHash("sha256")
        .update(JSON.stringify(["commit", operationId]))
        .digest("hex"),
      revision: 0,
    };
    const lease = await f.stores.leases.acquire({ resource: "run:run", holder: randomUUID() });
    await f.stores.leases.withOwnership(lease, async () => {
      await f.stores.events.appendDurableUnique!(
        {
          runId: "run",
          type: "revision.recorded",
          journal: correlation,
          payload: {
            destinationId: target.destinationId,
            revisionId,
            state: "pending",
            entry: {
              version: 1,
              entry: { kind: "commit", change: { operationId, record, supersedesRevisionId: receipt.revisionId } },
            },
          },
        },
        { expectedSeq: (await f.stores.events.lastSeq("run"))!, correlation, equivalent: () => false },
      );
    });
    await f.stores.leases.release(lease);
    const refused = {
      details: { reason: "revision-publication-uncertain", operationId: original.provenance.operationId },
    };
    await expect(f.service.readPending({ ...target, revisionId })).rejects.toMatchObject(refused);
    await expect(f.adapter.readBoundaries("run")).rejects.toMatchObject(refused);
    const resumed = await f.attach();
    await expect(f.adapter.runtime.reserveStep(resumed, "agent")).rejects.toMatchObject(refused);
    await f.stores.leases.release(resumed.lease!);
  });

  it.each(["attemptId", "generationId", "workflowRevision"] as const)(
    "fails closed on a mismatched %s in surviving v2 guard metadata",
    async (field) => {
      const f = await setup();
      const receipt = await f.submit();
      const address = `revision-publication:${createHash("sha256")
        .update(JSON.stringify(["run", "boundary-version", receipt.target.destinationId, receipt.expectedRevision]))
        .digest("hex")}`;
      await f.stores.execution.putGeneration(address, {
        version: 2,
        kind: "revision-publication-guard",
        runId: "run",
        destinationId: receipt.target.destinationId,
        expectedRevision: receipt.expectedRevision,
        attemptId: receipt.attemptId,
        generationId: f.boundary.generationId,
        workflowRevision: f.boundary.workflowRevision,
        operationId: "prior-operation",
        correlation: { kind: "revision", id: "prior-correlation", revision: 0 },
        [field]: "wrong-binding",
      });
      await expect(f.adapter.readBoundaries("run")).rejects.toMatchObject({ code: "RUN_STATE" });
      await expect(
        f.service.readPending({
          runId: "run",
          destinationId: receipt.target.destinationId,
          attemptId: receipt.attemptId,
          revisionId: receipt.revisionId,
        }),
      ).rejects.toMatchObject({ code: "RUN_STATE" });
    },
  );
  it.each(["malformed", "wrong-run"] as const)("fails closed on %s prior-v1 frontier evidence", async (fault) => {
    const f = await setup();
    const receipt = await f.submit();
    const address = `revision-publication:${createHash("sha256")
      .update(JSON.stringify(["run", "transition", receipt.revisionId, receipt.expectedRevision]))
      .digest("hex")}`;
    await f.stores.execution.putGeneration(address, {
      version: 1,
      kind: "revision-publication-guard",
      runId: fault === "wrong-run" ? "other-run" : "run",
      operationId: "prior-operation",
      correlation: { kind: "revision", id: "prior-correlation", revision: 0 },
      ...(fault === "malformed" ? { extra: true } : {}),
    });
    await expect(f.adapter.readBoundaries("run")).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(
      f.service.replacePending(
        {
          target: {
            runId: "run",
            revisionId: receipt.revisionId,
            destinationId: receipt.target.destinationId,
            attemptId: receipt.attemptId,
          },
          expectedRevision: receipt.expectedRevision,
          payload: { kind: "text", text: "R2" },
        },
        {},
        f.authority,
      ),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
  });
});
