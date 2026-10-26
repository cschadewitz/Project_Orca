/** Closed real Linux composition. Accepted image/lifetime and prompt presentation remain synthetic;
 * actual managed store, protected owner, strict policy, leases/auth, service and live registry are used.
 */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { InputsAnswerParamsSchema } from "@orca/protocol";
import { systemClock, type ActionEvidenceV1 } from "@orca/core";
import { fileStores, workspaceIdentity, lapsed } from "@orca/store";
import {
  askHumanInput,
  LiveHumanInput,
  bindOriginalDelivery,
  claimOriginalDelivery,
  readOriginalDelivery,
  type HumanInputQuery,
} from "@orca/engine";
import { createStrictPermissionSource, createStrictPolicyPort } from "@orca/agents";
import { CredentialStore } from "../../daemon/src/auth/credentials.js";
import { Authorizer, OwnershipStore, authInvalid, bindPrincipal } from "../../daemon/src/auth/index.js";
import { scopedPermissionMethods } from "../../daemon/src/scoped-permission-bridge.js";
import { dispatch } from "../../daemon/src/server.js";
import { protectedScopedPermissionOwner } from "../../daemon/src/protected-scoped-permission-owner.js";
import { ownedReadScopedCapture, ownedReadInputOptions } from "../../daemon/src/owned-read-scoped-capture.js";
import { createOwnedFileReadServiceForTest } from "../../engine/src/owned-file-read-service.js";
import type { SyntheticReadOwnerSnapshot } from "../../engine/src/synthetic-read-fence.js";
import { createManagedTypedWorkspace, resolveManagedRootBinding } from "../src/typed-workspace-gate.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const unavailable = (): never => {
  throw new Error("Original test authority unavailable");
};
const complete = <T>(value: T) => ({ state: "complete" as const, value });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orca-protected-owner-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "workspace"),
    control = join(root, "control"),
    releases = join(root, "releases");
  const storeDir = join(config, ".orca"),
    sidecar = join(config, "orca.permissions.json");
  for (const path of [config, control, releases, storeDir]) await mkdir(path, { mode: 0o700 });
  await workspaceIdentity(storeDir);
  const roots = resolveManagedRootBinding(
    [
      { role: "config", path: config },
      { role: "sidecar", path: sidecar },
      { role: "store", path: storeDir },
    ],
    control,
    releases,
  );
  const idBytes = await readFile(join(storeDir, "workspace-identity", "id"));
  const idHash = createHash("sha256").update(idBytes).digest("hex");
  await writeFile(join(control, "never-typed"), `${idHash}\n${roots.rootBindingRef}\n`, { mode: 0o600 });
  let lifetime = true,
    build = true;

  const managed = createManagedTypedWorkspace({
    binding: roots,
    lifetime: {
      mode: "enrollment",
      assertCurrent: () => {
        if (!lifetime) unavailable();
        return undefined;
      },
    },
    assertBuildCurrent: () => {
      if (!build) unavailable();
      return undefined;
    },
    qualify: (...args) => owner.qualify(...args),
  });
  const policy = await managed.enrollFresh();
  const available = await managed.currentStore();
  if (!available.available) throw new Error("managed test owner unavailable");
  const active = available.binding;
  let provider = () => managed.currentStore();
  const currentStore = () => provider();
  const stores = fileStores(storeDir);
  await stores.execution.putInputs({
    runId: "run",
    workflowId: "synthetic",
    workflowVersion: "1",
    vars: {},
    sensitiveNames: [],
    secrets: [],
  });
  const lease = await stores.leases.acquire({ resource: "run:run", holder: randomUUID() });
  const credentialFile = join(root, "credentials.json");
  const credentials = new CredentialStore({ file: credentialFile });
  const issued = await credentials.issue({
    principal: "synthetic-alice",
    permissions: ["permissions.grant", "inputs.answer"],
    scope: { workflows: "*", runs: "all" },
  });
  const actor = { principalId: issued.credential.principal, credentialId: issued.credential.id };
  const live = new LiveHumanInput("boot");
  const abort = new AbortController();
  const emit = (input: Parameters<typeof stores.events.append>[0]) => stores.events.append(input);
  let query!: HumanInputQuery;
  let lostAppendAck = false,
    lostOwnershipAck = false;
  const delivered = askHumanInput({
    port: live,
    emit: (input) => emit({ ...input, runId: "run" } as Parameters<typeof emit>[0]),
    clock: systemClock,
    runId: "run",
    stepRunId: "step",
    kind: "permission",
    question: "Synthetic read?",
    options: ["once", "deny"],
    live: {
      identity: { instanceId: "boot", sessionId: "session", turnId: "turn", invocationId: "invocation" },
      signal: abort.signal,
      withOwnership: async (work) => {
        const result = await stores.leases.withOwnership(lease, work);
        if (lostOwnershipAck) throw new Error("Synthetic lost ownership acknowledgement");
        return result;
      },
      emitOwned: async (input) => {
        const result = await emit({ ...input, runId: "run" } as Parameters<typeof emit>[0]);
        if (lostAppendAck) throw new Error("Synthetic lost append acknowledgement");
        return result;
      },
    },
    onRequested: (value) => {
      query = value;
    },
  });
  void delivered.catch(() => undefined);
  cleanup.push(async () => {
    live.close();
    await delivered.catch(() => undefined);
  });
  const target = {
    instanceId: "boot",
    sessionId: "session",
    turnId: "turn",
    invocationId: "invocation",
    runId: "run",
    stepRunId: "step",
    requestId: "unused-until-ask",
  };
  const owner = protectedScopedPermissionOwner({
    currentStore,
    live,
    credentials,
    leases: stores.leases,
    lease,
    execution: stores.execution,
    events: stores.events,
    captures: {
      read: (...args) => producer.port.read(...args),
      forAction: (...args) => producer.port.forAction(...args),
      snapshot: (...args) => producer.port.snapshot(...args),
      assertCurrent: (...args) => producer.port.assertCurrent(...args),
      policyChanged: (...args) => producer.port.policyChanged(...args),
    },
    disclosure: {
      approve: async () => ({
        // Explicit synthetic disclosure only. It contains no resource path/ref and grants nothing.
        scope: {
          principal: "Synthetic principal",
          operation: "Read",
          resources: "Disposable bytes",
          environment: "None",
          lifetime: "One minute",
          limits: "Exact bytes",
          authorizer: "Unavailable",
          coverage: "Policy per ask; Save unavailable",
        },
        projection: {},
        references: [],
      }),
    },
  });
  await expect.poll(() => !!query).toBe(true);
  target.requestId = query.requestId;
  const facts = await owner.readCaptureFacts(actor);
  const snapshot: { -readonly [K in keyof SyntheticReadOwnerSnapshot]: SyntheticReadOwnerSnapshot[K] } = {
    invocation: {
      ...target,
      rootRunId: "run",
      attemptId: "attempt",
      agentId: "synthetic-agent",
      hostId: "local",
      runnerId: "synthetic-runner",
      principalRef: actor.principalId,
    },
    authority: {
      capturedGeneration: "synthetic-original-ceiling",
      currentPolicyRevision: facts.policyRevision,
      authorityRevision: facts.authorityRevision,
      revocationEpoch: facts.revocationEpoch,
      leaseEpoch: facts.leaseEpoch,
    },
    coverage: {
      version: 1,
      coverageId: "initial",
      boundaryId: "initial",
      provider: "synthetic",
      providerVersion: "1",
      adapterVersion: "1",
      tool: "initial",
      toolSchemaVersion: "1",
      hostId: "local",
      platform: "linux",
      level: "observation",
      evidence: { sourceRefs: [], installedRefs: [], independentlyObservedEffects: false },
      negotiatedHook: { state: "unknown", reason: "No hook" },
      protectedConfiguration: { state: "unknown", reason: "No production configuration" },
      guaranteedEffects: [],
      unsupportedPaths: [],
    },
    cwd: config,
    workspaceRef: active.workspaceRef,
    relevantStateRefs: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const original = {
    signal: abort.signal,
    clock: systemClock,
    snapshot: () => snapshot,
    withOwnership: <T>(work: () => Promise<T>) => stores.leases.withOwnership(lease, work),
    authorize: async () => {
      await owner.readCaptureFacts(actor);
    },
    assertCurrent: (action: ActionEvidenceV1) => {
      active.assertCurrent();
      const current = credentials.current(actor.credentialId);
      if (!current.ok || lapsed(lease, Date.now())) unavailable();
      if (
        !isDeepStrictEqual(action.authority, snapshot.authority) ||
        !isDeepStrictEqual(action.invocation, snapshot.invocation)
      )
        unavailable();
    },
  };
  const observed = vi.fn(async () => {}),
    respond = vi.fn(async () => {});
  const service = createOwnedFileReadServiceForTest({
    enabled: true,
    owner: original,
    content: "Disposable synthetic bytes",
    maximumInvocations: 4,
    observed,
    respond,
  });
  cleanup.push(async () => service.close());
  const readFacts = vi.fn(owner.readCaptureFacts.bind(owner));
  const producer = ownedReadScopedCapture({
    service,
    currentStore,
    live,
    readCaptureFacts: readFacts,
  });
  const source = createStrictPermissionSource({
    capturedCeiling: complete(true),
    readBoundary: async () => ({
      authority: snapshot.authority,
      currentAuthority: complete(true),
      protectedAccess: complete(true),
      coverageAndState: complete(true),
      mandatoryHuman: complete(false),
      profile: complete({
        profileRef: "orca-owned-file-read-v1",
        minimumCoverage: "policy-per-ask",
        facts: {
          rawDuplicateKeyValidation: "complete-or-absent",
          effectiveCwd: "complete",
          workspaceRef: "complete",
          resources: "complete",
          executableAndInterpreter: "complete-or-absent",
          stdin: "complete-or-absent",
          environmentAndCredentialRefs: "complete",
          relevantStateRefs: "complete",
        },
      }),
    }),
    readRules: policy.readRules,
  });
  const strict = createStrictPolicyPort({
    source,
    authorizeProjection: async () => unavailable(),
    recordReview: async () => unavailable(),
  });
  const evidence = {
    recordCapture: async (action: ActionEvidenceV1, bytes: string) => {
      await stores.execution.putPayload(action.bindingRef, {
        type: "agent.update",
        runId: "run",
        payload: {
          stepRunId: "step",
          sessionId: "session",
          update: { kind: "capture", text: bytes },
        },
      });
    },
    recordAuthorization: vi.fn(async () => unavailable()),
    read: async () => ({}),
  };
  const input = {
    actor,
    target,
    query,
    onceOptionId: "once",
    denyOptionId: "deny",
    owner: original,
    parameters: { resourceRef: service.resourceRef, offset: 0, length: 4 },
    policy: strict,
    evidence,
  };
  const captured = await producer.capture(input);
  const reads = vi.spyOn(fs, "readSync");
  cleanup.push(async () => reads.mockRestore());
  const authorizer = new Authorizer({
    ownership: new OwnershipStore(),
    resolver: {
      run: async (id) => (id === "run" ? { workflowId: "synthetic" } : undefined),
      inputRun: async (id) => (id === target.requestId ? "run" : undefined),
      artifactRun: async () => undefined,
      claimRun: async () => undefined,
      workflowExists: () => true,
    },
    currentPrincipal: (original) => {
      const current = credentials.current(original.credentialId!);
      if (!current.ok) throw authInvalid();
      return current.principal;
    },
  });
  const authenticated = credentials.authenticate(issued.token);
  if (!authenticated.ok) throw new Error("Test credential unavailable");
  const principal = authenticated.principal;
  const identity = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
  };
  const methods = authorizer.guard({
    ...scopedPermissionMethods(owner, identity, authorizer),
    // Test-only transport adapter uses the real guard's exact live answer authority.
    "operator.answer": {
      params: InputsAnswerParamsSchema.pick({ optionId: true }),
      handle: (params, ctx) => live.answer({ target, optionId: params.optionId }, ctx.liveAnswerAuthority!),
    },
  });
  const call = (method: string, params: unknown) =>
    dispatch(
      JSON.stringify({ kind: "request", id: 1, method, params }),
      methods,
      bindPrincipal({ orcaVersion: "test", capabilities: [] }, principal, { transport: "http" }),
    );
  return {
    root,
    storeDir,
    sidecar,
    policy,
    active,
    stores,
    credentials,
    actor,
    owner,
    live,
    target,
    abort,
    delivered,
    producer,
    captured,
    input,
    snapshot,
    service,
    observed,
    respond,
    evidence,
    readFacts,
    reads,
    identity,
    call,
    replaceOwner: async () => {
      const replacement = createManagedTypedWorkspace({
        binding: roots,
        lifetime: { mode: "enrollment", assertCurrent: () => undefined },
        assertBuildCurrent: () => undefined,
        qualify: (...args) => owner.qualify(...args),
      });
      provider = () => replacement.currentStore();
      return replacement.currentStore();
    },
    breakLease: () => stores.leases.forceRelease(lease.resource),
    loseLifetime: () => {
      lifetime = false;
    },
    changeBuild: () => {
      build = false;
    },
    loseOwnershipAck: () => {
      lostOwnershipAck = true;
    },
    loseAck: () => {
      lostAppendAck = true;
    },
    revoke: () => new CredentialStore({ file: credentialFile }).revoke(actor.credentialId),
  };
}

it("retains actual service capture after protected facts, preserving independent resource workspace and unavailable provenance", async () => {
  const f = await fixture();
  expect(f.readFacts).toHaveBeenCalledWith(f.actor);
  expect(() => f.live.assertOriginalQuery({ ...f.input.query })).toThrow();
  expect(f.live.assertOriginalQuery(f.input.query)).toBeUndefined();
  expect(() => bindOriginalDelivery(f.live.retainOriginalDelivery(f.input.query), f.input.query, {})).toThrow();
  const c = f.producer.port.snapshot(f.captured.token);
  expect(c.action).toBe(f.captured.invocation.action);
  expect(c.binding).toBe(f.active);
  expect(f.producer.invocation(f.captured.token)).toBe(f.captured.invocation);
  expect(c.resourceWorkspaceRef).not.toBe(f.active.workspaceRef);
  expect(c.review).toEqual({ result: "unavailable", sourceRefs: [] });
  expect(c.action.coverage.level).toBe("policy-per-ask");
  expect(c.action.coverage.evidence.installedRefs).toEqual([]);
  expect(c.action.offeredChoices).toEqual([]);
  expect(ownedReadInputOptions(f.captured.token, c.action)).toEqual({ onceOptionId: "once", denyOptionId: "deny" });
  expect(ownedReadInputOptions({ ...f.captured.token }, c.action)).toBeUndefined();
  expect(() => ownedReadInputOptions(f.captured.token, { ...c.action, actionId: "forged" })).toThrow();
  expect(await f.producer.port.forAction(structuredClone(c.action), f.active)).toBe(f.captured.token);
  await expect(f.producer.capture(f.input)).rejects.toThrow();
  expect(f.observed).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});
it("real strict source and protected command bridge refuse unqualified review/Save, without answering or I/O", async () => {
  const f = await fixture();
  const result = await f.captured.invocation.evaluate(f.abort.signal);
  expect(result).toMatchObject({
    phase: "final",
    verdict: { outcome: "indeterminate", reason: "required-policy-unavailable" },
  });
  const before = await readFile(f.sidecar);
  expect((await f.call("scopedPermissions.review", { target: f.identity, input: f.target })).ok).toBe(false);
  expect(
    (await f.call("scopedPermissions.choose", { target: f.identity, handle: randomUUID(), choice: "save" })).ok,
  ).toBe(false);
  expect(f.live.inspect(f.target)).toBe("pending");
  expect(await f.stores.events.readTypes("run", ["agent.permission", "human.answered"])).toEqual([]);
  expect(await readFile(f.sidecar)).toEqual(before);
  expect(f.observed).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});
it("actual explicit live delivery reaches the original callback exactly once but supplies no native choice or permit authority", async () => {
  const f = await fixture();
  const before = await readFile(f.sidecar);
  const delivery = f.live.retainOriginalDelivery(f.input.query);
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.call("operator.answer", { optionId: "once" })));
  expect(responses.filter((result) => result.ok)).toHaveLength(1);
  expect(responses.find((result) => result.ok)).toMatchObject({
    ok: true,
    result: { answerRecorded: true, delivered: true },
  });
  expect(await f.delivered).toBe("once");
  expect((await f.call("operator.answer", { optionId: "once" })).ok).toBe(false);
  expect(await f.stores.events.readTypes("run", ["human.answered"])).toHaveLength(1);
  const answer = (await f.stores.events.readTypes("run", ["human.answered"]))[0]!;
  expect(answer.payload).toMatchObject({ actor: f.actor, answer: "once" });
  const proof = await readOriginalDelivery(delivery, f.input.query, f.actor, "once");
  expect(proof.acceptedAnswerRef).toBe(JSON.stringify(["run", answer.id]));
  await expect(readOriginalDelivery({ ...delivery }, f.input.query, f.actor, "once")).rejects.toThrow();
  await expect(readOriginalDelivery(delivery, { ...f.input.query }, f.actor, "once")).rejects.toThrow();
  await expect(
    readOriginalDelivery(delivery, f.input.query, { ...f.actor, credentialId: "other" }, "once"),
  ).rejects.toThrow();
  await expect(readOriginalDelivery(delivery, f.input.query, f.actor, "deny")).rejects.toThrow();
  // Neither a real delivery nor copied action JSON can replace its private pre-answer lineage.
  await expect(
    claimOriginalDelivery(delivery, f.input.query, f.actor, "once", structuredClone(f.captured.invocation.action), {}),
  ).rejects.toThrow();
  // A genuine delivery capability still cannot promote this unqualified executor.
  const execution = f.producer.executeHumanDelivery(f.captured.token, f.abort.signal);
  expect(f.producer.executeHumanDelivery(f.captured.token, f.abort.signal)).toBe(execution);
  await expect(execution).rejects.toThrow();
  expect(await readFile(f.sidecar)).toEqual(before);
  expect(() => f.producer.port.snapshot(f.captured.token)).toThrow();
  const verdict = {
    version: 1 as const,
    actionBindingRef: f.captured.invocation.action.bindingRef,
    authority: f.captured.invocation.action.authority,
    coverageId: f.service.coverage.coverageId,
    outcome: "allow" as const,
    authorizedBy: { kind: "human" as const, acceptedAnswerRef: answer.id },
  };
  await expect(
    f.captured.invocation.authorize(f.captured.invocation.action, verdict, f.abort.signal),
  ).rejects.toThrow();
  expect(f.evidence.recordAuthorization).not.toHaveBeenCalled();
  expect(f.observed).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});
it("lost durable answer acknowledgement never delivers, reopens a callback or creates execution authority", async () => {
  const f = await fixture();
  const delivery = f.live.retainOriginalDelivery(f.input.query);
  f.loseAck();
  expect((await f.call("operator.answer", { optionId: "once" })).ok).toBe(false);
  await expect(f.delivered).rejects.toThrow("lost append acknowledgement");
  expect(await f.stores.events.readTypes("run", ["human.answered"])).toHaveLength(1);
  await expect(readOriginalDelivery(delivery, f.input.query, f.actor, "once")).rejects.toThrow();
  await expect(f.producer.executeHumanDelivery(f.captured.token, f.abort.signal)).rejects.toThrow();
  expect((await f.call("operator.answer", { optionId: "once" })).ok).toBe(false);
  const restarted = new LiveHumanInput("boot");
  expect(restarted.inspect(f.target)).toBe("expired");
  expect(restarted.pendingCount).toBe(0);
  expect(() => f.producer.port.snapshot(f.captured.token)).toThrow();
  expect(f.observed).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});
it.each([
  "actor",
  "binding",
  "owner-binding",
  "image",
  "revision",
  "credential",
  "lease",
  "cancellation",
  "inode",
  "expiry",
] as const)("retained capture refuses stale %s without a read", async (reason) => {
  const f = await fixture();
  const facts = await f.owner.readCaptureFacts(f.actor);
  if (reason === "actor")
    await expect(
      f.owner.prepare(f.target, { ...f.actor, principalId: "other" }, await f.policy.read(), f.active),
    ).rejects.toThrow();
  if (reason === "binding") {
    await rename(join(f.storeDir, "workspace-identity"), join(f.storeDir, "old-identity"));
  }
  if (reason === "owner-binding") {
    const bytes = await readFile(f.sidecar);
    const replacement = await f.replaceOwner();
    expect(replacement.available).toBe(true);
    if (replacement.available) expect(replacement.binding).not.toBe(f.active);
    expect(await readFile(f.sidecar)).toEqual(bytes);
  }
  if (reason === "image") f.changeBuild();
  if (reason === "revision") await writeFile(f.sidecar, `${await readFile(f.sidecar, "utf8")}\n`);
  if (reason === "credential") await f.revoke();
  if (reason === "lease") await f.breakLease();
  if (reason === "cancellation") {
    f.abort.abort();
    expect(await f.delivered).toBeUndefined();
  }
  if (reason === "inode") f.service.close();
  if (reason === "expiry") f.snapshot.expiresAt = new Date(0).toISOString();
  if (reason !== "actor") await expect(f.producer.port.read(f.target, f.active, facts)).rejects.toThrow();
  expect(f.observed).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});
it("policyChanged refuses unqualified source evaluation and consumes the failed transition without replay", async () => {
  const f = await fixture();
  await f.captured.invocation.evaluate(f.abort.signal);
  const original = f.captured.invocation.action;
  const facts = await f.owner.readCaptureFacts(f.actor);
  // No Save is fabricated: even a trusted request cannot refresh an indeterminate source.
  await writeFile(f.sidecar, `${await readFile(f.sidecar, "utf8")}\n`);
  const changed = await f.owner.readCaptureFacts(f.actor);
  expect(changed.policyRevision).not.toBe(facts.policyRevision);
  f.snapshot.authority = { ...f.snapshot.authority, currentPolicyRevision: changed.policyRevision };
  // The real service refuses retirement of an indeterminate attempt, even with
  // authentic new byte facts. This must reach its facade, not manufacture a replacement.
  await expect(f.producer.port.policyChanged(f.captured.token, changed)).rejects.toThrow("synthetic read fence");
  await expect(f.producer.port.policyChanged(f.captured.token, changed)).rejects.toThrow("capture unavailable");
  expect(f.captured.invocation.action).toBe(original);
  expect(() => f.producer.port.snapshot(f.captured.token)).toThrow();
  expect(f.observed).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});

it("callback resolution followed by lost ownership acknowledgement never issues delivery authority", async () => {
  const f = await fixture();
  const delivery = f.live.retainOriginalDelivery(f.input.query);
  f.loseOwnershipAck();
  expect((await f.call("operator.answer", { optionId: "once" })).ok).toBe(false);
  expect(await f.delivered).toBe("once");
  expect(await f.stores.events.readTypes("run", ["human.answered"])).toHaveLength(1);
  await expect(readOriginalDelivery(delivery, f.input.query, f.actor, "once")).rejects.toThrow();
  await expect(f.producer.executeHumanDelivery(f.captured.token, f.abort.signal)).rejects.toThrow();
  expect(f.evidence.recordAuthorization).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});
it.each([
  "deny",
  "cancel",
  "credential",
  "binding",
  "image",
  "revision",
  "lease",
  "expiry",
  "registry-close",
  "query-target",
  "query-identity",
] as const)("original executor continuation refuses %s after delivery without a permit/read", async (reason) => {
  const f = await fixture();
  if (reason === "cancel") {
    f.abort.abort();
    expect(await f.delivered).toBeUndefined();
  } else {
    expect((await f.call("operator.answer", { optionId: reason === "deny" ? "deny" : "once" })).ok).toBe(true);
    expect(await f.delivered).toBe(reason === "deny" ? "deny" : "once");
  }
  if (reason === "credential") await f.revoke();
  if (reason === "binding") await f.replaceOwner();
  if (reason === "image") f.changeBuild();
  if (reason === "revision") await writeFile(f.sidecar, `${await readFile(f.sidecar, "utf8")}\n`);
  if (reason === "lease") await f.breakLease();
  if (reason === "expiry") f.snapshot.expiresAt = new Date(0).toISOString();
  if (reason === "registry-close") f.live.close();
  if (reason === "query-target") f.input.query.requestId = "replacement-query";
  if (reason === "query-identity") f.input.query.live!.identity.invocationId = "replacement-invocation";
  const execution = f.producer.executeHumanDelivery(f.captured.token, f.abort.signal);
  await expect(execution).rejects.toThrow();
  expect(f.producer.executeHumanDelivery(f.captured.token, f.abort.signal)).toBe(execution);
  expect(f.evidence.recordAuthorization).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});
