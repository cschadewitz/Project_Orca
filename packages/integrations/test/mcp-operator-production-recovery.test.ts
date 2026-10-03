/** Durable receipts across response loss, real process restart and concurrent production writers. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperatorMutationContracts } from "@orca/protocol";
import {
  ProductionFixture,
  accepted,
  refused,
  resolved,
  rpcResult,
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

describe.each(transports)("compiled production recovery via %s", (transport) => {
  for (const method of ["operator.admitRun", "operator.submitRequest"] as const)
    it(`R01 loses a committed ${method} acknowledgement, replays and correlates the actual receipt`, async (ctx) => {
      const direct = await f.connect(transport);
      await f.requireProduction(ctx, direct);
      const proxy = await f.loseAcknowledgement(method);
      const peer = await f.connect(transport, f.token, proxy.endpoint);
      const command = {
        ...(await f.guards(peer, "gate", method === "operator.submitRequest" ? "request" : "workflow")),
        vars: {},
        ...(method === "operator.submitRequest" ? { title: "Lost request", body: "PRIVATE_ACK_BODY" } : {}),
      };
      const params = OperatorMutationContracts[method].params.parse({
        target: peer.target,
        command,
        retry: { idempotencyKey: "ACK_PRIVATE_KEY" },
      });
      await refused(
        peer,
        method === "operator.admitRun" ? "start_workflow" : "submit_request",
        params,
        "AGENT_TRANSPORT",
      );
      expect(proxy.count()).toBe(1); // No implicit adapter retry of a possibly committed write.
      const original = accepted(OperatorMutationContracts[method].result.parse(proxy.dropped()));
      expect(original.replayed).toBe(false);
      const replay = accepted(await f.mutation(peer, method, params));
      expect(proxy.count()).toBe(2);
      expect(replay).toEqual({ ...original, replayed: true });
      await refused(
        peer,
        method === "operator.admitRun" ? "start_workflow" : "submit_request",
        {
          ...params,
          command: {
            ...params.command,
            ...(method === "operator.submitRequest" ? { body: "CHANGED_BODY" } : { vars: { changed: true } }),
          },
        },
        "RETRY_CONFLICT",
      );
      for (const lookup of ["operator.admission", "operator.reconcileAdmission"] as const) {
        const receipt = resolved(
          await f.mutation(peer, lookup, { target: peer.target, operationId: original.operationId }),
        );
        expect(receipt).toMatchObject({ operationId: original.operationId, result: original.result });
      }
      expect((await f.events(original.result.runId)).filter((event) => event.type === "run.created")).toHaveLength(1);
      expect(JSON.stringify(await f.audit())).not.toMatch(/ACK_PRIVATE_KEY|PRIVATE_ACK_BODY/);
    });

  it("R02 keeps one intent across daemon death and rejects the old instance target", async (ctx) => {
    const old = await f.connect(transport);
    await f.requireProduction(ctx, old);
    const initial = await f.start(old, "gate", "restart-intent");
    await f.pending(old, initial.runId);
    await f.stop(f.daemon, "SIGKILL");
    await f.boot();
    const peer = await f.connect(transport);
    expect(peer.target.workspaceId).toBe(old.target.workspaceId);
    expect(peer.target.instanceId).not.toBe(old.target.instanceId);
    await refused(peer, "start_workflow", initial.params, "RUN_STATE");
    const replay = accepted(await f.mutation(peer, "operator.admitRun", { ...initial.params, target: peer.target }));
    expect(replay).toEqual({ ...initial.receipt, replayed: true });
    const socket = await f.socket();
    for (const invoke of [(method: string, params: unknown) => f.rpc(method, params), socket]) {
      for (const method of ["operator.admission", "operator.reconcileAdmission"] as const) {
        const receipt = resolved(
          OperatorMutationContracts[method].result.parse(
            rpcResult(await invoke(method, { target: peer.target, operationId: replay.operationId })),
          ),
        );
        expect(receipt).toMatchObject({ operationId: replay.operationId, result: replay.result });
      }
    }
    expect((await f.events(initial.runId)).filter((event) => event.type === "run.created")).toHaveLength(1);
  });

  it("R03 serializes concurrent same-key writers in separate daemons and rejects a changed payload", async (ctx) => {
    const first = await f.connect(transport);
    await f.requireProduction(ctx, first);
    const secondDaemon = await f.boot();
    const second = await f.connect(transport, f.token, secondDaemon.endpoint);
    expect(second.target.instanceId).not.toBe(first.target.instanceId);
    const command = { ...(await f.guards(first)), vars: { intent: "same" } };
    const params = { target: first.target, command, retry: { idempotencyKey: "concurrent-intent" } };
    const attempts = await Promise.all([
      f.mutation(first, "operator.admitRun", params),
      f.mutation(second, "operator.admitRun", { ...params, target: second.target }),
    ]);
    expect(new Set(attempts.map((result) => result.operationId)).size).toBe(1);
    const eventual = await until(
      () => f.mutation(second, "operator.admitRun", { ...params, target: second.target }),
      (result) => result.state === "resolved",
      "concurrent admission settlement",
    );
    const receipt = accepted(eventual);
    expect(receipt.replayed).toBe(true);
    await refused(
      second,
      "start_workflow",
      { ...params, target: second.target, command: { ...command, vars: { intent: "different" } } },
      "RETRY_CONFLICT",
    );
    expect((await f.events(receipt.result.runId)).filter((event) => event.type === "run.created")).toHaveLength(1);
    const runs = await f.page(second, "runs");
    expect(runs.items).toHaveLength(1);
  });

  it("R04 loses a combined answer/continuation acknowledgement and recovers its durable correlation after restart", async (ctx) => {
    const originalPeer = await f.connect(transport);
    await f.requireProduction(ctx, originalPeer);
    const { runId } = await f.start(originalPeer);
    const input = await f.pending(originalPeer, runId);
    const proxy = await f.loseAcknowledgement("operator.continueRun");
    const peer = await f.connect(transport, f.token, proxy.endpoint);
    const params = {
      target: peer.target,
      command: {
        runId,
        expectedBoundary: await f.boundary(peer, runId),
        decision: { requestId: input.requestId!, optionId: "stop", note: "PRIVATE_CONTINUATION_RATIONALE" },
      },
      retry: { idempotencyKey: "continuation-ack-loss" },
    };
    await refused(peer, "continue_run", params, "AGENT_TRANSPORT");
    expect(proxy.count()).toBe(1);
    const first = resolved(OperatorMutationContracts["operator.continueRun"].result.parse(proxy.dropped()));
    await f.stop(f.daemon, "SIGKILL");
    await f.boot();
    const restarted = await f.connect(transport);
    const replay = resolved(
      await f.mutation(restarted, "operator.continueRun", { ...params, target: restarted.target }),
    );
    expect(replay).toMatchObject({
      replayed: true,
      operationId: first.operationId,
      result: { continuationId: first.result.continuationId, runId },
    });
    for (const method of ["operator.continuation", "operator.reconcileContinuation"] as const) {
      expect(
        await f.mutation(restarted, method, { target: restarted.target, continuationId: first.result.continuationId }),
      ).toMatchObject({ continuationId: first.result.continuationId, operationId: first.operationId, runId });
    }
    await refused(
      restarted,
      "continue_run",
      {
        ...params,
        target: restarted.target,
        command: { ...params.command, decision: { ...params.command.decision, optionId: "approve" } },
      },
      "RETRY_CONFLICT",
    );
    const events = await f.events(runId);
    expect(events.filter((event) => event.type === "continuation.recorded" && event.payload.decision)).toHaveLength(1);
    expect(JSON.stringify(await f.audit())).not.toContain("PRIVATE_CONTINUATION_RATIONALE");
  });

  it("R05 loses a revision acknowledgement and replays protected state across restart without re-delivery", async (ctx) => {
    const originalPeer = await f.connect(transport);
    await f.requireProduction(ctx, originalPeer);
    const { runId } = await f.start(originalPeer, "revision");
    const input = await until(
      () => f.pending(originalPeer, runId),
      (row) => row.revisionState === "available",
      "revision boundary",
    );
    const proxy = await f.loseAcknowledgement("operator.revise");
    const peer = await f.connect(transport, f.token, proxy.endpoint);
    const command = {
      target: input.revision!.target,
      actionId: input.revisionActionId!,
      payload: { kind: "text" as const, text: "PRIVATE_RECOVERED_REVISION" },
    };
    const params = { target: peer.target, command, retry: { idempotencyKey: "revision-ack-loss" } };
    await refused(peer, "revise_input", params, "AGENT_TRANSPORT");
    expect(proxy.count()).toBe(1);
    const first = resolved(OperatorMutationContracts["operator.revise"].result.parse(proxy.dropped()));
    await f.stop(f.daemon, "SIGKILL");
    await f.boot();
    const restarted = await f.connect(transport);
    expect(await f.mutation(restarted, "operator.revise", { ...params, target: restarted.target })).toEqual({
      ...first,
      replayed: true,
    });
    await f.status(restarted, runId, "waiting");
    const events = await f.events(runId);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_RECOVERED_REVISION");
    expect(JSON.stringify(await f.audit())).not.toContain("PRIVATE_RECOVERED_REVISION");
    expect(events.filter((event) => event.type === "agent.session.opened")).toHaveLength(0);
  });
});
