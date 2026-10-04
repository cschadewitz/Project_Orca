/** Current production grants, exact identities, live owner lifetime and bounded safe disclosure. */
import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OperatorDiscoverySchema,
  OperatorBoundaryPageResultSchema,
  OPERATOR_MAX_RESULT_BYTES,
  OperatorMutationContracts,
  type OperatorMutationName,
  type OperatorMutationParams,
  type OperatorMutationResult,
} from "@orca/protocol";
import {
  ProductionFixture,
  aliases,
  authenticationRefused,
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

describe.each(transports)("compiled production authority via %s", (transport) => {
  it("A01 rechecks revocation before dispatch for all ten tool names on an already connected client", async () => {
    const issued = await f.issue({ principal: "revocable", preset: "owner" });
    const peer = await f.connect(transport, issued.token);
    // Authentication precedes tool lookup, so this edge check is executable even
    // before mutation mounting. It does not claim that any alias handler ran.
    await peer.client.listTools();
    const socket = await f.socket(issued.token);
    await f.revoke(issued.credential.id);
    for (const name of Object.values(aliases)) {
      await authenticationRefused(peer, name, { secret: "PRIVATE_MALFORMED_INPUT" });
    }
    const response = await socket("operator.cancel", { target: peer.target, runId: "not-an-authority" }).catch(
      (error: unknown) => {
        expect(error).toMatchObject({ message: "Socket closed" });
        return undefined;
      },
    );
    if (response) expect(response).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    expect(JSON.stringify(await f.audit())).not.toContain("PRIVATE_MALFORMED_INPUT");
  });

  it("A02 enforces current grant combinations and workflow/owner scope without disclosing strong boundaries", async (ctx) => {
    const owner = await f.connect(transport);
    await f.requireProduction(ctx, owner);
    const { runId } = await f.start(owner, "revision");
    const input = await until(
      () => f.pending(owner, runId),
      (row) => row.revisionState === "available",
      "strong revision projection",
    );
    for (const permissions of [["runs.read"], ["runs.read", "inputs.answer"], ["runs.read", "runs.control"]] as const) {
      const issued = await f.issue({ principal: "weak", permissions, scope: { workflows: "*", runs: "all" } });
      const peer = await f.connect(transport, issued.token);
      const rows = await f.page(peer, "inputs", { runId });
      expect(rows.items).toHaveLength(1);
      expect(rows.items[0]).not.toHaveProperty("revision");
      expect(rows.items[0]?.revisionState).not.toBe("available");
      expect(rows.items[0]?.revisionActionId).toBe("changes");
      const run = await f.page(peer, "runs", { runId });
      const legacy = rpcResult(await f.rpc("runs.get", { runId }, issued.token)) as {
        continuation?: { expectedBoundary: string };
      };
      expect(run.items[0]?.expectedBoundary).toBe(legacy.continuation?.expectedBoundary);
      await refused(peer, "revise_input", {
        target: peer.target,
        command: {
          target: input.revision!.target,
          actionId: "changes",
          payload: { kind: "text", text: "NO_GRANT_PAYLOAD" },
        },
        retry: { idempotencyKey: randomUUID() },
      });
    }
    for (const scope of [
      { workflows: "*" as const, runs: "owned" as const },
      { workflows: ["gate"], runs: "all" as const },
    ]) {
      const issued = await f.issue({ principal: "outsider", preset: "client", scope });
      const peer = await f.connect(transport, issued.token);
      expect((await f.page(peer, "runs")).items).toEqual([]);
      for (const name of ["list_runs", "list_approvals", "get_events"])
        await refused(peer, name, { target: peer.target, runId });
      await refused(peer, "cancel_run", { target: peer.target, runId });
    }
    expect((await f.events(runId)).filter((event) => event.type === "human.answered")).toHaveLength(0);
  });

  it("A03 rejects changed deployment, exact durable input, caller authority injection and cross-run artifacts", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const { runId, params } = await f.start(peer);
    const other = await f.start(peer);
    const input = await f.pending(peer, runId);
    for (const field of ["workspaceId", "instanceId"] as const) {
      const target = { ...peer.target, [field]: randomUUID() };
      await refused(peer, "cancel_run", { target, runId }, "RUN_STATE");
      expect(await f.rpc("operator.cancel", { target, runId })).toMatchObject({ ok: false });
    }
    const decision = {
      lifetime: "durable",
      runId,
      stepRunId: input.stepRunId,
      requestId: input.requestId,
      optionId: "stop",
      resume: false,
    };
    for (const field of ["runId", "stepRunId", "requestId"] as const) {
      await refused(peer, "respond_to_approval", {
        target: peer.target,
        decision: { ...decision, [field]: field === "runId" ? other.runId : "wrong" },
      });
    }
    for (const field of ["principal", "credential", "lease", "execute", "runId"]) {
      await refused(peer, "start_workflow", { ...params, [field]: "CALLER_AUTHORITY" }, "PROTOCOL_MESSAGE");
    }
    await refused(
      peer,
      "respond_to_approval",
      { target: peer.target, decision: { ...decision, resume: true } },
      "PROTOCOL_MESSAGE",
    );
    await refused(
      peer,
      "respond_to_approval",
      { target: peer.target, decision: { ...decision, always: true } },
      "PROTOCOL_MESSAGE",
    );
    expect((await f.events(runId)).filter((event) => event.type === "human.answered")).toHaveLength(0);
    await f.mutation(peer, "operator.continueRun", {
      target: peer.target,
      command: {
        runId,
        expectedBoundary: await f.boundary(peer, runId),
        decision: { requestId: input.requestId!, optionId: "approve" },
      },
      retry: { idempotencyKey: "produce-artifact" },
    });
    await f.status(peer, runId, "succeeded");
    const artifactId = (await f.page(peer, "artifacts", { runId })).items[0]!.artifactId!;
    await refused(peer, "get_artifact", { target: peer.target, runId: other.runId, artifactId });
  });

  it("A04 requires every live identity field, rejects another owner, and delivers exactly once to the original callback", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const { runId } = await f.start(peer, "live");
    const input = await f.pending(peer, runId);
    expect(input.live?.state).toBe("pending");
    const live = input.live!.target;
    expect(live).toMatchObject({
      instanceId: peer.target.instanceId,
      runId,
      stepRunId: input.stepRunId,
      requestId: input.requestId,
    });
    for (const field of [
      "instanceId",
      "sessionId",
      "turnId",
      "invocationId",
      "runId",
      "stepRunId",
      "requestId",
    ] as const) {
      await refused(peer, "respond_to_approval", {
        target: peer.target,
        decision: { lifetime: "live", live: { ...live, [field]: "wrong" }, optionId: "allow" },
      });
    }
    const ownerEndpoint = peer.endpoint;
    await f.boot();
    const observer = await f.connect(transport);
    // Publication was established on the actual owner above; this different instance
    // must expose owner-unavailable, not satisfy the current-owner readiness check.
    const observed = (await f.page(observer, "inputs", { runId })).items[0]!;
    expect(observed.requestId).toBe(input.requestId);
    expect(observed.live?.state).toBe("owner-unavailable");
    await refused(observer, "respond_to_approval", {
      target: observer.target,
      decision: { lifetime: "live", live, optionId: "allow" },
    });
    expect((await f.events(runId)).filter((event) => event.type === "human.answered")).toHaveLength(0);
    const receipt = await f.mutation(peer, "operator.answer", {
      target: peer.target,
      decision: { lifetime: "live", live, optionId: "allow", note: "LIVE_RATIONALE_ONLY" },
    });
    expect(receipt).toMatchObject({ runId, requestId: live.requestId });
    await f.status(peer, runId, "succeeded");
    await refused(peer, "respond_to_approval", {
      target: peer.target,
      decision: { lifetime: "live", live, optionId: "allow" },
    });
    expect(peer.endpoint).toBe(ownerEndpoint);
    expect((await f.events(runId)).filter((event) => event.type === "human.answered")).toHaveLength(1);
  });

  it("A05 owner death expires the live callback and cannot be approved after restart", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const { runId } = await f.start(peer, "live");
    const input = await f.pending(peer, runId);
    expect(input.live?.state).toBe("pending");
    await f.stop(f.daemon, "SIGKILL");
    await f.boot();
    const restarted = await f.connect(transport);
    const current = (await f.page(restarted, "inputs", { runId })).items[0]!;
    expect(current.requestId).toBe(input.requestId);
    expect(["expired", "owner-unavailable"]).toContain(current.live?.state);
    await refused(restarted, "respond_to_approval", {
      target: restarted.target,
      decision: { lifetime: "live", live: input.live!.target, optionId: "allow" },
    });
    expect((await f.events(runId)).filter((event) => event.type === "human.answered")).toHaveLength(0);
  });

  it("A06 bounds reads, invalidates cursors on boundary changes, and never enriches an unscoped page", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const { runId } = await f.start(peer, "revision");
    const input = await until(
      () => f.pending(peer, runId),
      (row) => row.revisionState === "available",
      "revision boundary",
    );
    for (const row of (await f.page(peer, "runs")).items) {
      expect(row).not.toHaveProperty("expectedBoundary");
      expect(row).not.toHaveProperty("revision");
    }
    await refused(peer, "list_approvals", { target: peer.target }, "PROTOCOL_MESSAGE");
    const first = await f.page(peer, "events", { runId, limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    await f.mutation(peer, "operator.revise", {
      target: peer.target,
      command: {
        target: input.revision!.target,
        actionId: "changes",
        payload: { kind: "text", text: "PRIVATE_BOUNDARY_CHANGE" },
      },
      retry: { idempotencyKey: "change-boundary" },
    });
    const next = await f.page(peer, "events", { runId, limit: 1, cursor: first.nextCursor! });
    expect(next.restartRequired).toBe(true);
    expect(next.items).toEqual([]);
    const snapshot = await f.page(peer, "inputs", { runId });
    expect(
      snapshot.items.some((row) => row.revision?.target.expectedRevision === input.revision!.target.expectedRevision),
    ).toBe(false);
    await refused(peer, "get_events", { target: peer.target, runId, limit: 101 }, "PROTOCOL_MESSAGE");
    expect(await f.page(peer, "events", { runId, limit: 1, cursor: "forged" })).toMatchObject({
      restartRequired: true,
      items: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_BOUNDARY_CHANGE");
  });

  it("A07 withholds a late protected projection when the credential is revoked during transport publication", async (ctx) => {
    const owner = await f.connect(transport);
    await f.requireProduction(ctx, owner);
    const { runId } = await f.start(owner, "revision");
    await until(
      () => f.pending(owner, runId),
      (row) => row.revisionState === "available",
      "protected projection",
    );
    const issued = await f.issue({ principal: "late-reader", preset: "owner" });
    const barrier = await f.holdReply("operator.page");
    const peer = await f.connect(transport, issued.token, barrier.endpoint);
    barrier.arm();
    const pending = peer.client.callTool({ name: "list_approvals", arguments: { target: peer.target, runId } });
    await Promise.race([
      barrier.held,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Publication barrier not reached")), 5000);
        timer.unref();
      }),
    ]);
    await f.revoke(issued.credential.id);
    barrier.release();
    const response = await pending;
    expect(response.isError).toBe(true);
    expect(response).not.toHaveProperty("structuredContent");
    expect(JSON.stringify(response)).not.toContain("destinationId");
  });

  it("A08 audits authenticated identity and receipt correlations while excluding payloads, keys, rationale and credentials", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const { runId, receipt } = await f.start(peer, "gate", "PRIVATE_AUDIT_RETRY_KEY");
    const input = await f.pending(peer, runId);
    await f.mutation(peer, "operator.answer", {
      target: peer.target,
      decision: {
        lifetime: "durable",
        runId,
        stepRunId: input.stepRunId!,
        requestId: input.requestId!,
        optionId: "stop",
        note: "PRIVATE_AUDIT_NOTE",
        resume: false,
      },
    });
    const audit = await until(
      () => f.audit(),
      (entries) => entries.some((entry) => entry.operation === "operator.answer" && entry.outcome === "succeeded"),
      "durable audit flush",
    );
    const writes = audit.filter(
      (entry) =>
        ["operator.admitRun", "operator.answer"].includes(entry.operation ?? "") && entry.outcome === "succeeded",
    );
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const entry of writes) expect(entry.actor).toMatchObject({ principal: "acceptance-owner" });
    expect(writes.some((entry) => Object.values(entry.target ?? {}).includes(receipt.operationId))).toBe(true);
    expect(writes.some((entry) => Object.values(entry.target ?? {}).includes(runId))).toBe(true);
    const safe = JSON.stringify(audit);
    for (const secret of [...f.tokenSecrets, "PRIVATE_AUDIT_RETRY_KEY", "PRIVATE_AUDIT_NOTE", f.dir])
      expect(safe).not.toContain(secret);
    const failure = await refused(peer, "start_workflow", {
      target: peer.target,
      command: { ...(await f.guards(peer)), vars: {}, expectedWorkflowRevision: "STALE_PRIVATE_GUARD" },
      retry: { idempotencyKey: "PRIVATE_ERROR_KEY" },
    });
    expect(failure).not.toMatch(/STALE_PRIVATE_GUARD|PRIVATE_ERROR_KEY|stack|details/);
  });

  it("A09 enforces identical strict mutation schemas and current identity over backing HTTP and WS", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const socket = await f.socket();
    const started = await f.start(peer);
    for (const invoke of [(method: string, params: unknown) => f.rpc(method, params), socket]) {
      const receipt = resolved(
        OperatorMutationContracts["operator.admission"].result.parse(
          rpcResult(
            await invoke("operator.admission", { target: peer.target, operationId: started.receipt.operationId }),
          ),
        ),
      );
      expect(receipt.result).toEqual(started.receipt.result);
      for (const method of Object.keys(aliases) as OperatorMutationName[]) {
        expect(await invoke(method, { target: peer.target, principal: "forged" })).toMatchObject({ ok: false });
      }
      for (const key of ["", "é".repeat(65)]) {
        expect(await invoke("operator.admitRun", { ...started.params, retry: { idempotencyKey: key } })).toMatchObject({
          ok: false,
        });
      }
      expect(
        await invoke("operator.cancel", {
          target: { ...peer.target, workspaceId: randomUUID() },
          runId: started.runId,
        }),
      ).toMatchObject({ ok: false });
    }
    const discovery = OperatorDiscoverySchema.parse(await tool(peer.client, "discover_orca", {}));
    expect(discovery.operations).not.toContain("operator.replaceRevision");
  });

  it("A10 propagates missing protected evidence as a whole-read failure and restores authorized revision reads", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const ordinary = await f.start(peer);
    const ordinaryInput = await f.pending(peer, ordinary.runId);
    expect(ordinaryInput.revisionState).toBe("unsupported");
    expect(ordinaryInput).not.toHaveProperty("revision");
    const { runId } = await f.start(peer, "revision");
    await until(
      () => f.pending(peer, runId),
      (row) => row.revisionState === "available",
      "confirmed protected boundary",
    );
    const before = await f.page(peer, "inputs", { runId });
    const reader = await f.issue({ principal: "fault-reader", preset: "owner" });
    const revocable = await f.connect(transport, reader.token);
    // Remove one real protected publication payload, retaining its public marker. This is
    // isolated disk fault injection, not a fake callback or an invented empty boundary list.
    const raw = (await readFile(join(f.dir, "state/runs", `${runId}.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; executionPayloadRef?: string });
    const marker = raw.find((event) => event.type === "revision.recorded");
    expect(marker?.executionPayloadRef).toBeTruthy();
    const file = join(
      f.dir,
      "state/private-execution",
      `${encodeURIComponent(marker!.executionPayloadRef!)}.payload.json`,
    );
    await rename(file, `${file}.held`);
    try {
      // Generic RUN_STATE from missing durable evidence is not a typed transient
      // unavailability signal. The authorized whole read must fail, not emit a row.
      const failure = await refused(peer, "list_approvals", { target: peer.target, runId }, "RUN_STATE");
      expect(failure).not.toMatch(/destinationId|expectedBoundary|revisionState/);
      await f.revoke(reader.credential.id);
      await authenticationRefused(revocable, "list_approvals", { target: revocable.target, runId });
    } finally {
      await rename(`${file}.held`, file);
    }
    const restored = await f.page(peer, "inputs", { runId });
    expect(restored.items[0]?.revisionState).toBe("available");
    expect(restored.items[0]?.revision).toEqual(before.items[0]?.revision);
    await authenticationRefused(revocable, "list_approvals", { target: revocable.target, runId });
  });

  it("A12 keeps cold-read uncertainty safe without waiting, retrying or turning store failures into empty success", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const { runId } = await f.start(peer, "revision");
    // Deliberately no readiness phase. Timing may yield a valid snapshot or a safe
    // refusal; this does not claim that every run hits a concurrent-publication race.
    for (const name of ["list_approvals", "list_runs"]) {
      const result = await peer.client.callTool({ name, arguments: { target: peer.target, runId } });
      const text = JSON.stringify(result);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(OPERATOR_MAX_RESULT_BYTES);
      expect(text).not.toContain(peer.token);
      expect(text).not.toContain(f.dir);
      expect(text).not.toMatch(/"(?:stack|details)"/);
      if (result.isError) {
        expect(result).not.toHaveProperty("structuredContent");
        expect(text).toContain("RUN_STATE");
        expect(text).not.toMatch(/destinationId|expectedBoundary|revisionState/);
      } else {
        const page = OperatorBoundaryPageResultSchema.parse(result.structuredContent);
        // The read model explicitly invalidates a snapshot if publication changes
        // during the read. That is a restart signal, never an empty settled result.
        if (page.restartRequired) {
          expect(page.items).toEqual([]);
          expect(page.truncated).toBe(false);
          expect(page).not.toHaveProperty("nextCursor");
        }
        for (const row of page.items) {
          expect(row.runId).toBe(runId);
          if (row.revision) expect(row.revision.target.runId).toBe(runId);
          if (row.revisionState !== "available") expect(row).not.toHaveProperty("revision");
          if (row.continuationState !== "available") expect(row).not.toHaveProperty("expectedBoundary");
        }
      }
    }
    // A cold read cannot replace the subsequent, stronger settled assertion.
    expect((await f.pending(peer, runId)).revisionState).toBe("available");
  });

  it("A11 executes all ten aliases successfully through both backing transports using real receipts and effects", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const socket = await f.socket();
    for (const [wire, rpc] of [
      ["http", (method: string, params: unknown) => f.rpc(method, params)],
      ["ws", socket],
    ] as const) {
      const invoke = async <N extends OperatorMutationName>(
        method: N,
        params: OperatorMutationParams<N>,
      ): Promise<OperatorMutationResult<N>> => {
        const result = rpcResult(await rpc(method, params));
        const parsed = OperatorMutationContracts[method].result.parse(result);
        expect(result).toEqual(parsed);
        return parsed as OperatorMutationResult<N>;
      };
      const direct = resolved(
        await invoke("operator.admitRun", {
          target: peer.target,
          command: { ...(await f.guards(peer)), vars: {} },
          retry: { idempotencyKey: `${wire}-direct` },
        }),
      );
      if (direct.result.state !== "accepted") throw new Error("Backing admission not accepted");
      const request = resolved(
        await invoke("operator.submitRequest", {
          target: peer.target,
          command: { ...(await f.guards(peer, "gate", "request")), title: "Parity", body: "Parity workload" },
          retry: { idempotencyKey: `${wire}-request` },
        }),
      );
      expect(request.result.requestId).toBeTruthy();
      expect(direct.result).not.toHaveProperty("requestId");
      for (const method of ["operator.admission", "operator.reconcileAdmission"] as const)
        expect(resolved(await invoke(method, { target: peer.target, operationId: direct.operationId })).result).toEqual(
          direct.result,
        );
      const runId = direct.result.runId;
      const input = await f.pending(peer, runId);
      expect(
        await invoke("operator.answer", {
          target: peer.target,
          decision: {
            lifetime: "durable",
            runId,
            stepRunId: input.stepRunId!,
            requestId: input.requestId!,
            optionId: "stop",
            resume: false,
          },
        }),
      ).toMatchObject({ runId, requestId: input.requestId });
      const continuation = resolved(
        await invoke("operator.continueRun", {
          target: peer.target,
          command: { runId, expectedBoundary: await f.boundary(peer, runId) },
          retry: { idempotencyKey: `${wire}-continue` },
        }),
      );
      const lookup = { target: peer.target, continuationId: continuation.result.continuationId };
      const identity = {
        operationId: continuation.operationId,
        runId,
        continuationId: continuation.result.continuationId,
      };
      expect(await invoke("operator.continuation", lookup)).toMatchObject(identity);
      await f.status(peer, runId, "succeeded");
      expect(await invoke("operator.reconcileContinuation", lookup)).toMatchObject({ ...identity, state: "settled" });
      if (request.result.state !== "accepted") throw new Error("Backing Request not accepted");
      await f.pending(peer, request.result.runId);
      expect(await invoke("operator.cancel", { target: peer.target, runId: request.result.runId })).toMatchObject({
        runId: request.result.runId,
      });
      await f.status(peer, request.result.runId, "cancelled");
      const revisionRun = await f.start(peer, "revision");
      const revision = await until(
        () => f.pending(peer, revisionRun.runId),
        (row) => row.revisionState === "available",
        "backing revision boundary",
      );
      const receipt = resolved(
        await invoke("operator.revise", {
          target: peer.target,
          command: {
            target: revision.revision!.target,
            actionId: "changes",
            payload: { kind: "text", text: "BACKING_PARITY_PRIVATE" },
          },
          retry: { idempotencyKey: `${wire}-revision` },
        }),
      );
      expect(receipt.result).toMatchObject({ state: "pending", target: revision.revision!.target });
      expect(JSON.stringify(await f.events(revisionRun.runId))).not.toContain("BACKING_PARITY_PRIVATE");
    }
  });
});
