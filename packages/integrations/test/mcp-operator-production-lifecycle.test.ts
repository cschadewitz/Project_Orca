/** Production lifecycle acceptance: discovery, admission, exact answers, continuation and protected revision delivery. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HelloResultSchema,
  OperatorDiscoverySchema,
  PROTOCOL_VERSION,
  RunsAdmitResultSchema,
  InputsListResultSchema,
  RunsGetResultSchema,
  RunsContinueResultSchema,
  RevisionResultSchema,
} from "@orca/protocol";
import {
  ProductionFixture,
  accepted,
  aliases,
  refused,
  resolved,
  rpcResult,
  tool,
  transports,
  until,
} from "./mcp-operator-production-fixture.js";

let f: ProductionFixture;
beforeEach(async () => {
  f = await ProductionFixture.create();
});
afterEach(async () => {
  await f?.close();
});

describe.each(transports)("compiled production lifecycle via %s", (transport) => {
  it("F01 authenticates actual discovery and backing HTTP/WS parity without inventing capabilities", async () => {
    const peer = await f.connect(transport);
    const discovery = OperatorDiscoverySchema.parse(await tool(peer.client, "discover_orca", {}));
    expect(discovery.principalId).toBe("acceptance-owner");
    const socket = await f.socket();
    const http = OperatorDiscoverySchema.parse(rpcResult(await f.rpc("operator.discover", {})));
    const ws = OperatorDiscoverySchema.parse(rpcResult(await socket("operator.discover", {})));
    expect(discovery).toMatchObject({ target: http.target, operations: http.operations, scope: http.scope });
    expect(ws).toMatchObject({ target: http.target, operations: http.operations, scope: http.scope });
    const hello = HelloResultSchema.parse(
      rpcResult(await f.rpc("hello", { client: "acceptance", protocol: PROTOCOL_VERSION })),
    );
    for (const operation of discovery.operations) expect(hello.methods).toContain(operation);
    const tools = (await peer.client.listTools()).tools.map((entry) => entry.name);
    for (const [method, name] of Object.entries(aliases))
      expect(tools.includes(name)).toBe(discovery.operations.includes(method));
    expect(tools).not.toContain("replace_pending_revision");
  });

  it("F02 executes real preflight, legacy admission and bounded reads on isolated disk state", async () => {
    const peer = await f.connect(transport);
    const command = await f.guards(peer);
    const admitted = RunsAdmitResultSchema.parse(
      rpcResult(await f.rpc("runs.admit", { ...command, idempotencyKey: "fixture-proof" })),
    );
    if (admitted.state !== "accepted") throw new Error("Fixture legacy admission did not accept");
    const input = await f.pending(peer, admitted.runId);
    expect(input.runId).toBe(admitted.runId);
    expect(input.options?.map((option) => option.id)).toEqual(["approve", "stop"]);
    await f.status(peer, admitted.runId, "waiting");
    const first = await f.page(peer, "events", { runId: admitted.runId, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await f.page(peer, "events", { runId: admitted.runId, limit: 1, cursor: first.nextCursor! });
    expect(second.restartRequired).toBe(false);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect((await f.events(admitted.runId)).filter((event) => event.type === "run.created")).toHaveLength(1);
  });

  for (const workflowId of ["revision", "live", "parent"])
    it(`F03 seeds a real ${workflowId} workload through shared production services`, async () => {
      const peer = await f.connect(transport);
      const admitted = RunsAdmitResultSchema.parse(
        rpcResult(
          await f.rpc("runs.admit", { ...(await f.guards(peer, workflowId)), idempotencyKey: `fixture-${workflowId}` }),
        ),
      );
      if (admitted.state !== "accepted") throw new Error("Fixture workload was not admitted");
      let inputRunId = admitted.runId;
      if (workflowId === "parent") {
        await f.readyStatus(peer, admitted.runId, "waiting");
        const children = await f.page(peer, "children", { runId: admitted.runId });
        const child = children.items.find((row) => row.kind === "child.spawned");
        expect(child?.childRunId).toBeTruthy();
        inputRunId = child!.childRunId!;
      }
      // The preparation does not wire MCP live-owner projections. Readiness proves
      // the real callback through inputs.list; A04 asserts MCP ownership after mount.
      await f.readyInput(peer, inputRunId);
      // These are fixture proofs through the existing service; they do not accept an absent alias.
      const inputs = await until(
        async () =>
          rpcResult(await f.rpc("inputs.list", { runId: inputRunId }, peer.token, peer.endpoint)) as {
            inputs: { runId: string; live?: { state: string }; revision?: unknown }[];
          },
        (value) => value.inputs.length > 0 && (workflowId !== "revision" || value.inputs[0]?.revision !== undefined),
        "production workload input",
      );
      if (workflowId === "live") expect(inputs.inputs[0]?.live?.state).toBe("pending");
      if (workflowId === "parent") expect(inputs.inputs[0]?.runId).not.toBe(admitted.runId);
      if (workflowId === "revision") expect(inputs.inputs[0]?.revision).toBeDefined();
    });

  for (const workflowId of ["gate", "revision"])
    it(`F04 proves ${workflowId} continuation and scripted execution using existing production RPCs`, async () => {
      const peer = await f.connect(transport);
      const admitted = RunsAdmitResultSchema.parse(
        rpcResult(
          await f.rpc("runs.admit", { ...(await f.guards(peer, workflowId)), idempotencyKey: `execute-${workflowId}` }),
        ),
      );
      if (admitted.state !== "accepted") throw new Error("Fixture workload was not admitted");
      const runId = admitted.runId;
      await f.readyInput(peer, runId);
      const input = InputsListResultSchema.parse(rpcResult(await f.rpc("inputs.list", { runId }))).inputs[0]!;
      if (workflowId === "revision") {
        expect(input.revision).toBeDefined();
        const receipt = resolved(
          RevisionResultSchema.parse(
            rpcResult(
              await f.rpc("inputs.revise", {
                command: {
                  target: input.revision!.target,
                  actionId: "changes",
                  payload: { kind: "text", text: "FIXTURE_PROTECTED_CORRECTION" },
                },
                retry: { idempotencyKey: "fixture-revision" },
              }),
            ),
          ),
        );
        expect(receipt.result.state).toBe("pending");
      } else
        rpcResult(
          await f.rpc("inputs.answer", {
            requestId: input.id,
            optionId: "approve",
            note: "FIXTURE_RATIONALE_ONLY",
            resume: false,
          }),
        );
      const run = RunsGetResultSchema.parse(rpcResult(await f.rpc("runs.get", { runId })));
      expect(run.continuation?.expectedBoundary).toBeTruthy();
      const continuation = resolved(
        RunsContinueResultSchema.parse(
          rpcResult(
            await f.rpc("runs.continue", {
              command: { runId, expectedBoundary: run.continuation!.expectedBoundary },
              retry: { idempotencyKey: "fixture-continuation" },
            }),
          ),
        ),
      );
      expect(continuation.result.runId).toBe(runId);
      await f.status(peer, runId, "succeeded");
      const prompts = await readFile(join(f.dir, "worker-prompts.jsonl"), "utf8");
      expect(prompts).not.toContain("FIXTURE_RATIONALE_ONLY");
      if (workflowId === "revision") expect(prompts).toContain("FIXTURE_PROTECTED_CORRECTION");
      expect((await f.page(peer, "artifacts", { runId })).items).toHaveLength(1);
    });

  it("L01 mounts all ten real aliases and keeps Request and direct run identities distinct", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const direct = await f.start(peer);
    expect(direct.receipt.replayed).toBe(false);
    expect(direct.receipt.result).not.toHaveProperty("requestId");
    const command = {
      ...(await f.guards(peer, "gate", "request")),
      title: "Synthetic request",
      body: "SYNTHETIC PRIVATE BODY",
    };
    const request = accepted(
      await f.mutation(peer, "operator.submitRequest", {
        target: peer.target,
        command,
        retry: { idempotencyKey: "request-intent" },
      }),
    );
    expect(request.replayed).toBe(false);
    expect(request.result.requestId).toBeTruthy();
    expect(request.result.runId).not.toBe(direct.runId);
    for (const receipt of [request, direct.receipt]) {
      for (const method of ["operator.admission", "operator.reconcileAdmission"] as const) {
        const inspected = resolved(
          await f.mutation(peer, method, { target: peer.target, operationId: receipt.operationId }),
        );
        expect(inspected.operationId).toBe(receipt.operationId);
        expect(inspected.result).toEqual(receipt.result);
      }
      const events = await f.events(receipt.result.runId);
      expect(events.filter((event) => event.type === "run.created")).toHaveLength(1);
    }
    expect((await f.page(peer, "requests")).items.map((row) => row.id)).toContain(request.result.requestId);
    expect(JSON.stringify(await f.page(peer, "requests"))).not.toContain("SYNTHETIC PRIVATE BODY");
  });

  it("L02 records an exact durable answer without resuming; rationale never becomes agent input", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const { runId } = await f.start(peer);
    const input = await f.pending(peer, runId);
    const decision = {
      lifetime: "durable" as const,
      runId,
      stepRunId: input.stepRunId!,
      requestId: input.requestId!,
      optionId: "approve",
      note: "RATIONALE_ONLY_327",
      resume: false as const,
    };
    const receipt = await f.mutation(peer, "operator.answer", { target: peer.target, decision });
    expect(receipt).toMatchObject({ runId, requestId: input.requestId });
    await f.status(peer, runId, "waiting");
    expect((await f.events(runId)).filter((event) => event.type === "human.answered")).toHaveLength(1);
    await refused(peer, "respond_to_approval", { target: peer.target, decision });
    const expectedBoundary = await f.boundary(peer, runId);
    const continuation = resolved(
      await f.mutation(peer, "operator.continueRun", {
        target: peer.target,
        command: { runId, expectedBoundary },
        retry: { idempotencyKey: "continue-answered" },
      }),
    );
    expect(continuation.operationId).toBe(continuation.result.operationId);
    expect(continuation.result).toMatchObject({ runId, expectedBoundary });
    const lookup = { target: peer.target, continuationId: continuation.result.continuationId };
    const identity = {
      operationId: continuation.operationId,
      runId,
      continuationId: continuation.result.continuationId,
    };
    expect(await f.mutation(peer, "operator.continuation", lookup)).toMatchObject(identity);
    await f.status(peer, runId, "succeeded");
    // Reconciliation is a mutation, not a readiness poll: invoke it once after
    // read-only observation proves the service has settled and released execution.
    expect(await f.mutation(peer, "operator.reconcileContinuation", lookup)).toMatchObject({
      ...identity,
      state: "settled",
    });
    const prompts = await readFile(join(f.dir, "worker-prompts.jsonl"), "utf8");
    expect(prompts).toContain("ORIGINAL TASK");
    expect(prompts).not.toContain("RATIONALE_ONLY_327");
    const artifacts = await f.page(peer, "artifacts", { runId });
    const artifactId = artifacts.items[0]!.artifactId!;
    const artifact = await tool(peer.client, "get_artifact", { target: peer.target, runId, artifactId });
    expect(JSON.stringify(artifact)).toContain("ACCEPTANCE ARTIFACT");
    expect(JSON.stringify(artifact)).not.toContain(f.dir);
    const bounded = await tool(peer.client, "get_artifact", { target: peer.target, runId, artifactId, maxBytes: 8 });
    expect(bounded).toMatchObject({ omitted: "tooLarge" });
    expect(bounded).not.toHaveProperty("text");
  });

  it("L03 admits answer plus root continuation once and refuses terminal or mismatched-child continuation", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const parent = await f.start(peer, "parent");
    await f.readyStatus(peer, parent.runId, "waiting");
    const children = await until(
      () => f.page(peer, "children", { runId: parent.runId }),
      (page) => page.items.length > 0,
      "real child run",
    );
    const childId = children.items[0]!.childRunId!;
    await f.pending(peer, childId);
    const root = await f.start(peer);
    const rootInput = await f.pending(peer, root.runId);
    const parentBoundary = await f.boundary(peer, root.runId);
    // This proves refusal of a cross-run boundary. It does not independently prove
    // the root-only restriction: boundary mismatch is already sufficient to refuse.
    await refused(peer, "continue_run", {
      target: peer.target,
      command: { runId: childId, expectedBoundary: parentBoundary },
      retry: { idempotencyKey: "child-must-not-resume" },
    });
    const params = {
      target: peer.target,
      command: {
        runId: root.runId,
        expectedBoundary: parentBoundary,
        decision: { requestId: rootInput.requestId!, optionId: "stop", note: "ROOT_RATIONALE" },
      },
      retry: { idempotencyKey: "root-answer-and-continue" },
    };
    const first = resolved(await f.mutation(peer, "operator.continueRun", params));
    const replay = resolved(await f.mutation(peer, "operator.continueRun", params));
    expect(replay).toMatchObject({
      operationId: first.operationId,
      replayed: true,
      result: { continuationId: first.result.continuationId },
    });
    await f.status(peer, root.runId, "succeeded");
    await refused(peer, "continue_run", { ...params, retry: { idempotencyKey: "new-terminal-intent" } });
    const records = (await f.observedEvents(peer, root.runId)).filter(
      (event) => event.type === "continuation.recorded",
    );
    expect(records.map((event) => event.payload.continuationId)).toEqual(Array(3).fill(first.result.continuationId));
    expect(records.map((event) => event.payload.state)).toEqual(["accepted", "accepted", "settled"]);
    const decisions = records.filter((event) => event.payload.decision);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload.decision).toMatchObject({
      requestId: rootInput.requestId,
      stepRunId: rootInput.stepRunId,
      answer: "stop",
    });
    expect(
      await f.mutation(peer, "operator.continuation", {
        target: peer.target,
        continuationId: first.result.continuationId,
      }),
    ).toMatchObject({ operationId: first.operationId, runId: root.runId, state: "settled" });
  });

  it("L04 submits a pinned revision, replays its receipt, validates destination and delivers protected text once", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const { runId } = await f.start(peer, "revision");
    const input = await until(
      () => f.pending(peer, runId),
      (row) => row.revisionState === "available",
      "real revision projection",
    );
    const boundary = input.revision!;
    expect(input.revisionActionId).toBe(boundary.capability.actionId);
    expect(boundary.target).toMatchObject({ runId, stepRunId: input.stepRunId, requestId: input.requestId });
    const params = {
      target: peer.target,
      command: {
        target: boundary.target,
        actionId: boundary.capability.actionId,
        payload: { kind: "text" as const, text: "PROTECTED_CORRECTION_327" },
      },
      retry: { idempotencyKey: "revision-intent" },
    };
    for (const field of ["runId", "stepRunId", "requestId", "destinationId", "expectedRevision"] as const) {
      await refused(peer, "revise_input", {
        ...params,
        command: { ...params.command, target: { ...boundary.target, [field]: "wrong" } },
        retry: { idempotencyKey: `wrong-${field}` },
      });
    }
    await refused(peer, "revise_input", {
      ...params,
      command: { ...params.command, actionId: "undeclared-action" },
      retry: { idempotencyKey: "wrong-action" },
    });
    await refused(peer, "respond_to_approval", {
      target: peer.target,
      decision: {
        lifetime: "durable",
        runId,
        stepRunId: input.stepRunId,
        requestId: input.requestId,
        optionId: "changes",
        resume: false,
      },
    });
    for (const payload of [
      { kind: "text", text: "" },
      { kind: "text", text: "é".repeat(513) },
      { kind: "values", values: { correction: "wrong declaration kind" } },
    ]) {
      await refused(peer, "revise_input", { ...params, command: { ...params.command, payload } });
    }
    const first = resolved(await f.mutation(peer, "operator.revise", params));
    expect(first.result).toMatchObject({ state: "pending", target: boundary.target });
    expect(first.replayed).toBe(false);
    expect(await f.mutation(peer, "operator.revise", params)).toEqual({ ...first, replayed: true });
    await refused(
      peer,
      "revise_input",
      { ...params, command: { ...params.command, payload: { kind: "text", text: "changed" } } },
      "RETRY_CONFLICT",
    );
    expect(JSON.stringify(await f.events(runId))).not.toContain("PROTECTED_CORRECTION_327");
    expect(JSON.stringify(await f.page(peer, "events", { runId }))).not.toContain("PROTECTED_CORRECTION_327");
    expect(JSON.stringify(await f.page(peer, "inputs", { runId }))).not.toContain("PROTECTED_CORRECTION_327");
    await f.mutation(peer, "operator.continueRun", {
      target: peer.target,
      command: { runId, expectedBoundary: await f.boundary(peer, runId) },
      retry: { idempotencyKey: "deliver-revision" },
    });
    await f.status(peer, runId, "succeeded");
    const prompts = (await readFile(join(f.dir, "worker-prompts.jsonl"), "utf8")).trim().split("\n");
    expect(prompts.filter((line) => line.includes("PROTECTED_CORRECTION_327"))).toHaveLength(1);
    expect(JSON.stringify(await f.events(runId))).toContain(first.result.revisionId);
  });

  it("L05 cancels the exact run and descendants with a real receipt and no second answer", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const { runId } = await f.start(peer, "parent");
    await f.readyStatus(peer, runId, "waiting");
    const children = await until(
      () => f.page(peer, "children", { runId }),
      (page) => page.items.length > 0,
      "child creation",
    );
    await f.pending(peer, children.items[0]!.childRunId!);
    const receipt = await f.mutation(peer, "operator.cancel", {
      target: peer.target,
      runId,
      reason: "SYNTHETIC_CANCELLATION_REASON",
    });
    expect(receipt.runId).toBe(runId);
    await f.status(peer, runId, "cancelled");
    await f.status(peer, children.items[0]!.childRunId!, "cancelled");
    expect((await f.events(runId)).filter((event) => event.type === "run.cancelled")).toHaveLength(1);
  });
});
