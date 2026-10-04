/** Alias operation grants precede diagnostics; existing services own current resource authority. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  OperatorMutationContracts,
  PROTOCOL_VERSION,
  type HelloResult,
  type OperatorMutationName,
} from "@orca/protocol";
import { operatorMutationParams, operatorTarget } from "../../protocol/test/fixtures/operator-mutations.js";
import { dispatch } from "../src/server.js";
import type { MethodContext, MethodTable } from "../src/methods.js";
import {
  Authorizer,
  MemoryAuditSink,
  OPERATIONS,
  OwnershipStore,
  PERMISSIONS,
  bindPrincipal,
  type Permission,
  type Principal,
  type ResourceResolver,
} from "../src/auth/index.js";

const grants: Record<OperatorMutationName, readonly Permission[]> = {
  "operator.submitRequest": ["runs.start", "plan.write"],
  "operator.admitRun": ["runs.start"],
  "operator.admission": ["runs.start"],
  "operator.reconcileAdmission": ["runs.start"],
  "operator.cancel": ["runs.control"],
  "operator.answer": ["inputs.answer"],
  "operator.continueRun": ["runs.control"],
  "operator.continuation": ["runs.read"],
  "operator.reconcileContinuation": ["runs.control"],
  "operator.revise": ["inputs.answer", "runs.control"],
};
const names = Object.keys(grants) as OperatorMutationName[];
const ctx: MethodContext = { orcaVersion: "authority-test", capabilities: [] };
const meta = { transport: "http" as const };
const principal = (permissions: readonly Permission[]): Principal => ({
  id: "authenticated-operator",
  kind: "credential",
  credentialId: "authenticated-credential",
  permissions: new Set(permissions),
  scope: { runs: "all", workflows: "*" },
});
function setup() {
  const resolver: ResourceResolver = {
    run: vi.fn(async () => undefined),
    inputRun: vi.fn(async () => undefined),
    artifactRun: vi.fn(async () => undefined),
    claimRun: vi.fn(async () => undefined),
    workflowExists: vi.fn(() => false),
  };
  const audit = new MemoryAuditSink();
  return { audit, authorizer: new Authorizer({ resolver, ownership: new OwnershipStore(), audit }) };
}
function tableFor(name: OperatorMutationName, result?: unknown) {
  const handler = vi.fn(() => result);
  const methods: MethodTable = {
    [name]: { params: OperatorMutationContracts[name].params, handle: handler },
  };
  return { methods, handler };
}
const missingGrants = names.flatMap((name) => grants[name].map((missing) => ({ name, missing })));

describe("operator mutation operation authority", () => {
  it("inventories all ten prepared aliases and their exact grants", () => {
    expect(names.sort()).toEqual(Object.keys(OperatorMutationContracts).sort());
    for (const name of names) {
      const operation = OPERATIONS[name]!;
      expect([operation.permission, ...(operation.additionalPermissions ?? [])]).toEqual(grants[name]);
      expect(operation.resource).toBe("none");
    }
  });

  it.each(missingGrants)(
    "refuses $name without $missing before malformed-input diagnostics",
    async ({ name, missing }) => {
      const { audit, authorizer } = setup();
      const { handler, methods } = tableFor(name);
      // Every unrelated permission is present: no other grant may substitute for the missing one.
      const caller = principal(PERMISSIONS.filter((permission) => permission !== missing));
      const bound = bindPrincipal(ctx, caller, meta);
      const response = await dispatch(
        JSON.stringify({ kind: "request", id: 7, method: name, params: { secret: "malformed-input-secret" } }),
        authorizer.guard(methods),
        bound,
        (method, exists) => authorizer.checkOperation(caller, method, exists, meta),
      );
      expect(response).toEqual({
        kind: "response",
        id: 7,
        ok: false,
        error: { code: "AUTH_FORBIDDEN", message: "not permitted" },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(audit.records).toMatchObject([{ event: "authz.denied", operation: name, code: "AUTH_FORBIDDEN" }]);
      expect(JSON.stringify(audit.records)).not.toContain("malformed-input-secret");
      // An embedder invoking a guarded handler directly cannot bypass the operation check either.
      await expect(authorizer.guard(methods)[name]!.handle({}, bound)).rejects.toMatchObject({
        code: "AUTH_FORBIDDEN",
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(names)("permits %s diagnostics with exactly its operation grants", async (name) => {
    const { authorizer } = setup();
    const { handler, methods } = tableFor(name);
    const caller = principal(grants[name]);
    const response = await dispatch(
      JSON.stringify({ kind: "request", id: 1, method: name, params: {} }),
      authorizer.guard(methods),
      bindPrincipal(ctx, caller, meta),
      (method, exists) => authorizer.checkOperation(caller, method, exists, meta),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "PROTOCOL_MESSAGE" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(names)("advertises %s only when every operation grant is held", async (name) => {
    const { authorizer } = setup();
    const helloResult: HelloResult = {
      protocol: PROTOCOL_VERSION,
      orcaVersion: "authority-test",
      capabilities: [...names],
      methods: [...names],
    };
    const methods = authorizer.guard({ hello: { params: z.object({}), handle: () => helloResult } });
    const check = async (permissions: readonly Permission[], visible: boolean) => {
      const caller = principal(permissions);
      const discovered = (await methods.hello!.handle({}, bindPrincipal(ctx, caller, meta))) as HelloResult;
      expect(discovered.methods?.includes(name)).toBe(visible);
      expect(discovered.capabilities.includes(name)).toBe(visible);
      expect(authorizer.permittedMethods(caller, [name])).toEqual(visible ? [name] : []);
    };
    await check(grants[name], true);
    for (const missing of grants[name])
      await check(
        PERMISSIONS.filter((permission) => permission !== missing),
        false,
      );
    await check([], false);
  });
});

describe("operator mutation audit targets", () => {
  const expectedActor = {
    principal: "authenticated-operator",
    kind: "credential",
    credential: "authenticated-credential",
  };
  const secrets = {
    retry: { idempotencyKey: "raw-retry-key-secret" },
    actor: { principalId: "supplied-actor-secret" },
    note: "note-secret",
    reason: "reason-secret",
  };
  const cases: { name: OperatorMutationName; params: unknown; result: unknown; target: Record<string, string> }[] = [
    {
      name: "operator.submitRequest",
      params: {
        ...operatorMutationParams["operator.submitRequest"],
        ...secrets,
        command: {
          ...operatorMutationParams["operator.submitRequest"].command,
          body: "request-body-secret",
          actor: secrets.actor,
          vars: { runId: "payload-run-id-secret" },
        },
      },
      result: {
        state: "resolved",
        operationId: "operation",
        replayed: true,
        result: {
          state: "accepted",
          admissionId: "admission",
          requestId: "request",
          runId: "run",
          body: "receipt-body-secret",
        },
      },
      target: {
        ...operatorTarget,
        workflowId: "workflow",
        operationId: "operation",
        admissionId: "admission",
        requestId: "request",
        runId: "run",
      },
    },
    {
      name: "operator.admitRun",
      params: { ...operatorMutationParams["operator.admitRun"], ...secrets },
      result: { state: "in-progress", operationId: "operation", recovery: "inspect-or-retry" },
      target: { ...operatorTarget, workflowId: "workflow", operationId: "operation" },
    },
    {
      name: "operator.answer",
      params: {
        target: operatorTarget,
        ...secrets,
        decision: {
          ...operatorMutationParams["operator.answer"].decision,
          optionId: "answer-text-secret",
          note: secrets.note,
        },
      },
      result: { runId: "run", requestId: "input", asOf: "2026-10-03T00:00:00.000Z" },
      target: { ...operatorTarget, runId: "run", stepRunId: "step", requestId: "input" },
    },
    {
      name: "operator.answer",
      params: {
        target: operatorTarget,
        ...secrets,
        decision: {
          lifetime: "live",
          optionId: "answer-text-secret",
          note: secrets.note,
          live: {
            runId: "run",
            stepRunId: "step",
            requestId: "input",
            instanceId: "live-instance",
            sessionId: "session",
            turnId: "turn",
            invocationId: "invocation",
          },
        },
      },
      result: { runId: "run", requestId: "input", asOf: "2026-10-03T00:00:00.000Z" },
      target: {
        ...operatorTarget,
        runId: "run",
        stepRunId: "step",
        requestId: "input",
        liveInstanceId: "live-instance",
        sessionId: "session",
        turnId: "turn",
        invocationId: "invocation",
      },
    },
    {
      name: "operator.continueRun",
      params: {
        target: operatorTarget,
        ...secrets,
        command: {
          runId: "run",
          expectedBoundary: "boundary-guard-secret",
          decision: { requestId: "input", optionId: "answer-text-secret", note: secrets.note },
        },
      },
      result: {
        state: "resolved",
        operationId: "operation",
        replayed: false,
        result: { continuationId: "continuation", runId: "run" },
      },
      target: {
        ...operatorTarget,
        runId: "run",
        requestId: "input",
        operationId: "operation",
        continuationId: "continuation",
      },
    },
    {
      name: "operator.revise",
      params: {
        ...operatorMutationParams["operator.revise"],
        ...secrets,
        command: {
          ...operatorMutationParams["operator.revise"].command,
          payload: { kind: "values", values: { runId: "payload-run-id-secret", actor: secrets.actor } },
          supersedesRevisionId: "prior-revision",
        },
      },
      result: {
        state: "resolved",
        operationId: "operation",
        replayed: true,
        result: { revisionId: "new-revision", attemptId: "attempt", payload: "receipt-body-secret" },
      },
      target: {
        ...operatorTarget,
        runId: "run",
        stepRunId: "step",
        requestId: "input",
        destinationId: "destination",
        actionId: "changes",
        supersedesRevisionId: "prior-revision",
        operationId: "operation",
        revisionId: "new-revision",
        attemptId: "attempt",
      },
    },
  ];

  it.each(cases)(
    "records only authenticated actor and allowlisted IDs for $name",
    async ({ name, params, result, target }) => {
      const { authorizer, audit } = setup();
      const { methods } = tableFor(name, result);
      await authorizer.guard(methods)[name]!.handle(params, bindPrincipal(ctx, principal(PERMISSIONS), meta));
      expect(audit.records).toMatchObject([
        { event: "operation", operation: name, actor: expectedActor, outcome: "succeeded", target },
      ]);
      expect(audit.records[0]?.target).toEqual(target);
      expect(JSON.stringify(audit.records)).not.toContain("secret");
    },
  );

  it.each(["operator.reconcileAdmission", "operator.reconcileContinuation", "operator.cancel"] as const)(
    "retains safe correlation IDs on failed and denied %s calls",
    async (name) => {
      const { authorizer, audit } = setup();
      const params = { ...operatorMutationParams[name], ...secrets };
      const methods: MethodTable = {
        [name]: {
          params: OperatorMutationContracts[name].params,
          handle: () => {
            throw Object.assign(new Error("exception-body-secret"), { code: "AUTH_FORBIDDEN" });
          },
        },
      };
      await expect(
        authorizer.guard(methods)[name]!.handle(params, bindPrincipal(ctx, principal(PERMISSIONS), meta)),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      const { target: _target, ...ids } = operatorMutationParams[name];
      expect(audit.records).toHaveLength(2);
      for (const entry of audit.records) {
        expect(entry.actor).toEqual(expectedActor);
        expect(entry.target).toEqual({ ...operatorTarget, ...ids });
      }
      expect(audit.records.map((entry) => entry.event)).toEqual(["authz.denied", "operation"]);
      expect(JSON.stringify(audit.records)).not.toContain("secret");
    },
  );

  it.each(["operator.admission", "operator.continuation"] as const)(
    "does not mutation-audit a successful %s read",
    async (name) => {
      const { authorizer, audit } = setup();
      const { methods } = tableFor(name, {});
      await authorizer
        .guard(methods)
        [name]!.handle(operatorMutationParams[name], bindPrincipal(ctx, principal(PERMISSIONS), meta));
      expect(audit.records).toEqual([]);
    },
  );
});
