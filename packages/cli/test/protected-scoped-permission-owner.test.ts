/** Actual managed/file/auth/lease/store integration. Accepted image and inherited boot
 * ownership remain explicit synthetic assumptions; no qualified execution is fabricated.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { systemClock, type ActionEvidenceV1 } from "@orca/core";
import { fileStores, workspaceIdentity } from "@orca/store";
import { askHumanInput, LiveHumanInput, type HumanInputQuery } from "@orca/engine";
import type { ManagedTypedStoreBinding, ScopedPermissionCapture, ScopedPermissionCapturePort } from "@orca/agents";
import { CredentialStore } from "../../daemon/src/auth/credentials.js";
import { Authorizer, OwnershipStore, authInvalid, type ResourceResolver } from "../../daemon/src/auth/index.js";
import { scopedPermissionMethods } from "../../daemon/src/scoped-permission-bridge.js";
import { startDaemon } from "../../daemon/src/server.js";
import { protectedScopedPermissionOwner } from "../../daemon/src/protected-scoped-permission-owner.js";
import { createDisposableFileReadForTest } from "../../engine/src/disposable-file-read.js";
import { SyntheticReadFence, type SyntheticReadOwnerSnapshot } from "../../engine/src/synthetic-read-fence.js";
import { createManagedTypedWorkspace, resolveManagedRootBinding } from "../src/typed-workspace-gate.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const unavailable = (): never => {
  throw new Error("actual qualified capture unavailable");
};
async function fixture(capture = false) {
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
      withOwnership: (work) => stores.leases.withOwnership(lease, work),
      emitOwned: (input) => emit({ ...input, runId: "run" } as Parameters<typeof emit>[0]),
    },
    onRequested: (value) => {
      query = value;
    },
  });
  cleanup.push(async () => {
    live.close();
    await delivered;
  });
  // A local registry holds only the actual fence's immutable action. It never invents
  // choices, review success, installed refs or verified-per-execution coverage.
  const registrations = new WeakMap<object, ActionEvidenceV1>();
  let handle: ScopedPermissionCapture | undefined;
  let action: ActionEvidenceV1 | undefined;
  let file: ReturnType<typeof createDisposableFileReadForTest> | undefined;
  let registeredBinding: ManagedTypedStoreBinding = active;
  const captures: ScopedPermissionCapturePort = {
    read: async () => handle ?? unavailable(),
    forAction: async (candidate) => (action && candidate.actionId === action.actionId ? handle! : unavailable()),
    snapshot: (token) => {
      const retained = registrations.get(token);
      if (!retained) return unavailable();
      return {
        action: retained,
        target,
        binding: registeredBinding,
        actor,
        resourceWorkspaceRef: retained.workspaceRef.state === "complete" ? retained.workspaceRef.value : unavailable(),
        review: { result: "unavailable", sourceRefs: [] },
      };
    },
    assertCurrent: (token) => {
      const retained = registrations.get(token);
      if (!retained || !file) return unavailable();
      file.owner.assertCurrent(retained);
      return undefined;
    },
    policyChanged: async () => unavailable(),
  };
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
    currentStore: managed.currentStore,
    live,
    credentials,
    leases: stores.leases,
    lease,
    execution: stores.execution,
    events: stores.events,
    captures,
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
  if (capture) {
    const facts = await owner.readCaptureFacts(actor);
    const snapshot: SyntheticReadOwnerSnapshot = {
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
        capturedGeneration: "synthetic-original-boot-ceiling",
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
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    file = createDisposableFileReadForTest({
      enabled: true,
      content: "synthetic bytes",
      owner: {
        signal: abort.signal,
        clock: systemClock,
        snapshot: () => snapshot,
        withOwnership: (work) => stores.leases.withOwnership(lease, work),
        authorize: async () => unavailable(),
        assertCurrent: () => {
          active.assertCurrent();
          const current = credentials.current(actor.credentialId);
          if (!current.ok) unavailable();
        },
      },
      policy: (_resource, current) => ({
        authority: current.authority,
        currentAuthority: { state: "complete", value: false },
        capturedCeiling: { state: "complete", value: false },
        protectedAccess: { state: "complete", value: false },
        coverageAndState: { state: "complete", value: false },
        mandatoryHuman: { state: "complete", value: true },
        profile: { state: "unknown", reason: "Fixture cannot execute" },
        rules: { state: "unknown", reason: "No qualified rules" },
      }),
      observed: async () => unavailable(),
      respond: async () => unavailable(),
    });
    cleanup.push(async () => {
      file!.dispose();
    });
    const fence = new SyntheticReadFence(
      file.owner,
      file.executor,
      {
        version: 1,
        evaluate: async () => unavailable(),
        bindReview: async () => unavailable(),
        completeReview: async () => unavailable(),
      },
      {
        recordCapture: async () => unavailable(),
        recordAuthorization: async () => unavailable(),
        read: async () => unavailable(),
      },
    );
    action = fence.capture({ resourceRef: file.resourceRef, offset: 0, length: 4 });
    handle = Object.freeze({}) as ScopedPermissionCapture;
    registrations.set(handle, action);
  }
  return {
    root,
    storeDir,
    sidecar,
    managed,
    policy,
    active,
    stores,
    credentials,
    issued,
    owner,
    target,
    actor,
    action,
    revoke: () => new CredentialStore({ file: credentialFile }).revoke(actor.credentialId),
    breakLease: () => stores.leases.forceRelease(lease.resource),
    loseLifetime: () => {
      lifetime = false;
    },
    changeBuild: () => {
      build = false;
    },
    replaceCaptureBinding: (replacement: ManagedTypedStoreBinding) => {
      registeredBinding = replacement;
    },
  };
}
it("binds actual byte revision, credential and lease facts before any capture and never persists on review", async () => {
  const f = await fixture();
  const facts = await f.owner.readCaptureFacts(f.actor);
  expect(facts.policyRevision).toBe((await f.policy.read()).revision);
  expect(facts.authorityRevision).toMatch(/^[0-9a-f]{64}$/);
  await expect(f.owner.prepare(f.target, f.actor, await f.policy.read(), f.active)).rejects.toThrow(
    "capture unavailable",
  );
  expect(await f.stores.events.readTypes("run", ["agent.permission", "human.answered"])).toEqual([]);
  expect((await f.policy.read()).document.scopedRules.records).toEqual([]);
  await expect(f.owner.inspectRule("missing-rule", f.actor)).rejects.toThrow();
});
it.each(["actor", "credential", "lease", "lifetime", "build", "root"] as const)(
  "fresh facts refuse changed %s",
  async (reason) => {
    const f = await fixture();
    await f.owner.readCaptureFacts(f.actor);
    if (reason === "credential") await f.revoke();
    if (reason === "lease") await f.breakLease();
    if (reason === "lifetime") f.loseLifetime();
    if (reason === "build") f.changeBuild();
    if (reason === "root") await rename(join(f.storeDir, "workspace-identity"), join(f.storeDir, "old-identity"));
    await expect(
      f.owner.readCaptureFacts(reason === "actor" ? { ...f.actor, principalId: "other" } : f.actor),
    ).rejects.toThrow();
    expect(await f.stores.events.readTypes("run", ["agent.permission"])).toEqual([]);
  },
);
it("the actual file fence remains policy-per-ask with no choices; protected review and qualification refuse it", async () => {
  const f = await fixture(true);
  expect(f.action!.coverage.level).toBe("policy-per-ask");
  expect(f.action!.coverage.evidence.installedRefs).toEqual([]);
  expect(f.action!.offeredChoices).toEqual([]);
  await expect(f.owner.prepare(f.target, f.actor, await f.policy.read(), f.active)).rejects.toThrow();
  expect(await f.policy.readRules(f.action!, new AbortController().signal)).toMatchObject({ state: "unavailable" });
  expect(await f.stores.events.readTypes("run", ["agent.permission", "human.answered"])).toEqual([]);
});
it("a fresh live registry does not reconstruct callbacks from durable inputs/events", async () => {
  const f = await fixture();
  const before = await readFile(f.sidecar);
  const restarted = new LiveHumanInput("fresh-boot");
  expect((await fileStores(f.storeDir).execution.getInputs("run"))?.runId).toBe("run");
  expect(await fileStores(f.storeDir).events.readTypes("run", ["human.requested"])).toHaveLength(1);
  expect(restarted.pendingCount).toBe(0);
  expect(restarted.inspect(f.target)).toBe("owner-unavailable");
  await expect(f.owner.prepare(f.target, f.actor, await f.policy.read(), f.active)).rejects.toThrow();
  expect(await readFile(f.sidecar)).toEqual(before);
  expect((await f.policy.read()).document.scopedRules.records).toEqual([]);
});
it("authenticated HTTP bridge refuses the actual unqualified file capture without disclosure or approval", async () => {
  const f = await fixture(true);
  const identity = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
  };
  const resolver: ResourceResolver = {
    run: async (id) => (id === "run" ? { workflowId: "synthetic" } : undefined),
    inputRun: async (id) => (id === f.target.requestId ? "run" : undefined),
    artifactRun: async () => undefined,
    claimRun: async () => undefined,
    workflowExists: () => true,
  };
  const ownership = new OwnershipStore();
  const authorizer = new Authorizer({
    ownership,
    resolver,
    currentPrincipal: (original) => {
      const current = f.credentials.current(original.credentialId!);
      if (!current.ok) throw authInvalid();
      return current.principal;
    },
  });
  const daemon = await startDaemon({
    orcaVersion: "synthetic",
    capabilities: [],
    methods: scopedPermissionMethods(f.owner, identity, authorizer),
    auth: { mode: "token", credentials: f.credentials, ownership, resolver },
  });
  try {
    for (const token of ["invalid", f.issued.token]) {
      const response = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "request",
          id: 1,
          method: "scopedPermissions.review",
          params: { target: identity, input: f.target },
        }),
      });
      const result = (await response.json()) as { ok: boolean };
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(f.root);
      expect(JSON.stringify(result)).not.toContain(f.actor.credentialId);
    }
    expect((await f.policy.read()).document.scopedRules.records).toEqual([]);
    expect(await f.stores.events.readTypes("run", ["agent.permission", "human.answered"])).toEqual([]);
  } finally {
    await daemon.close();
  }
});
