/** Actual sidecar + file-backed answer log in disposable stores. All approval/compatibility owners are synthetic. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeClock, type OrcaEventInput } from "@orca/core";
import { fileStores } from "@orca/store";
import { askHumanInput, LiveHumanInput, type HumanInputQuery, type LiveInputBinding } from "@orca/engine";
import {
  bindInactiveTypedSidecarOwner,
  createInactiveTypedSidecarStore,
  strictPermissionRuleRevision,
  type CreateScopedRule,
} from "@orca/agents";
import {
  Authorizer,
  CredentialStore,
  authInvalid,
  OwnershipStore,
  type Principal,
  type ResourceResolver,
} from "../src/auth/index.js";
import { scopedPermissionMethods, type RetainedScopedReview } from "../src/scoped-permission-bridge.js";
import { startDaemon, dispatch } from "../src/server.js";
import { bindPrincipal } from "../src/auth/guard.js";
import { actionFixture } from "../../agents/test/strict-permission-fixtures.js";
import { ruleFixture } from "../../agents/test/strict-permission-fixtures.js";
const faults = vi.hoisted(() => ({
  publication: false,
  readTarget: "",
  afterRead: undefined as (() => Promise<void>) | undefined,
  afterDispatch: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const result = await fs.readFile(...args);
      if (args[0] === faults.readTarget && faults.afterRead) {
        const hook = faults.afterRead;
        faults.afterRead = undefined;
        await hook();
      }
      return result;
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args);
      if (String(args[1]).endsWith("orca.permissions.json") && faults.afterDispatch) {
        const hook = faults.afterDispatch;
        faults.afterDispatch = undefined;
        await hook();
      }
      if (faults.publication && String(args[1]).endsWith("orca.permissions.json"))
        throw new Error("lost policy acknowledgement");
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  faults.publication = false;
  faults.readTarget = "";
  faults.afterRead = undefined;
  faults.afterDispatch = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orca-typed-live-"));
  roots.push(root);
  const file = join(root, "orca.permissions.json");
  const stores = fileStores(join(root, "store"));
  const lease = await stores.leases.acquire({ resource: "run:run", holder: "owner" });
  const marker = {
    version: 1,
    workspaceRef: "synthetic:workspace",
    sidecarRef: "synthetic:sidecar",
    format: "orca-permissions-v2",
    minimumWriterContract: "orca-typed-sidecar-v1",
    rootBindingRef: "synthetic:original-root-binding",
    enrollmentRef: "synthetic:enrollment",
    state: "enrolled",
  } as const;
  const owner = bindInactiveTypedSidecarOwner({
    file,
    marker,
    checkCompatibility: async () => marker,
    assertCompatibilityCurrent: () => undefined,
    qualify: async () => {
      throw new Error("fixture never evaluates actions");
    },
  });
  const policy = createInactiveTypedSidecarStore(owner);
  const pendingMarker = { ...marker, state: "enrollment-pending" as const };
  const initializer = createInactiveTypedSidecarStore(
    bindInactiveTypedSidecarOwner({
      file,
      marker: pendingMarker,
      checkCompatibility: async () => pendingMarker,
      assertCompatibilityCurrent: () => undefined,
      qualify: async () => {
        throw new Error("not evaluated");
      },
    }),
  );
  const snapshot = await initializer.initializeFresh();
  const credentialFile = join(root, "credentials.json");
  const credentialOwner = new CredentialStore({ file: credentialFile });
  const issued = await credentialOwner.issue({
    principal: "synthetic-alice",
    permissions: ["permissions.grant", "inputs.answer"],
    scope: { workflows: "*", runs: "all" },
  });
  const checked = credentialOwner.current(issued.credential.id);
  if (!checked.ok) throw new Error("synthetic credential unavailable");
  const principal = checked.principal;
  let currentOverride: Principal | undefined;
  const resolver: ResourceResolver = {
    run: async () => ({ workflowId: "synthetic" }),
    inputRun: async () => "run",
    artifactRun: async () => undefined,
    claimRun: async () => undefined,
    workflowExists: () => true,
  };
  const authorizer = new Authorizer({
    ownership: new OwnershipStore(),
    resolver,
    currentPrincipal: () => {
      if (currentOverride) return currentOverride;
      const latest = credentialOwner.current(issued.credential.id);
      if (!latest.ok) throw authInvalid();
      return latest.principal;
    },
  });
  const command: CreateScopedRule = {
    rule: { ...ruleFixture(), ruleRevision: strictPermissionRuleRevision(ruleFixture()) },
    expectedRevision: snapshot.revision,
    approvalRecordRef: "synthetic:explicit-reviewed-scope",
  };
  // Protected synthetic review is captured independently, before any client command. It is not derived from an answer.
  const approved = structuredClone(command);
  const verifyApproval = vi.fn(
    async (candidate: CreateScopedRule, actor: { principalId: string; credentialId?: string }) => {
      expect(candidate).toEqual(approved);
      expect(actor).toEqual({ principalId: principal.id, credentialId: principal.credentialId });
      expect(await stores.events.readTypes("run", ["human.answered"])).toHaveLength(1);
      return { scopeEvidenceRef: "synthetic:explicit-scope-evidence" };
    },
  );
  const grant = authorizer.scopedRuleGrantAuthority(principal, {
    readAuthorityRevision: async () => "synthetic:current-authority",
    assertCommitCurrent: (candidate, actor, proof) => {
      expect(candidate).toEqual(approved);
      expect(actor).toEqual({ principalId: principal.id, credentialId: principal.credentialId });
      expect(proof).toEqual({
        authorityRevision: "synthetic:current-authority",
        scopeEvidenceRef: "synthetic:explicit-scope-evidence",
      });
      return undefined;
    },
    verifyApproval,
  });
  const port = new LiveHumanInput("boot");
  const abort = new AbortController();
  const order: string[] = [];
  let uncertainAppend = false;
  const emit = async (event: Omit<OrcaEventInput, "runId">) => {
    await stores.events.append({ ...event, runId: "run" } as OrcaEventInput);
    if (event.type === "human.answered") {
      order.push("record");
      if (uncertainAppend) throw new Error("lost answer acknowledgement");
    }
  };
  const live: LiveInputBinding = {
    identity: { instanceId: "boot", sessionId: "session", turnId: "turn", invocationId: "invocation" },
    signal: abort.signal,
    withOwnership: (write) => stores.leases.withOwnership(lease, write),
    emitOwned: emit,
  };
  let query!: HumanInputQuery;
  const delivered = askHumanInput({
    port,
    emit,
    clock: new FakeClock(),
    runId: "run",
    stepRunId: "step",
    kind: "permission",
    question: "Synthetic read?",
    options: ["once", "deny"],
    live,
    onRequested: (q) => {
      query = q;
    },
  });
  void delivered.then(
    () => order.push("delivery"),
    () => undefined,
  );
  await vi.waitFor(() => expect(query).toBeDefined());
  const target = { ...live.identity, runId: "run", stepRunId: "step", requestId: query.requestId };
  await vi.waitFor(() => expect(port.inspect(target)).toBe("pending"));
  const writer = vi.fn(async () => {
    await policy.createScopedRule(command, grant);
    order.push("policy");
  });
  const liveAuthority = {
    actor: grant.actor,
    authorize: async () => {
      await grant.authorizeGrant();
    },
  };
  const answer = () => port.answer({ target, optionId: "once", standing: true }, liveAuthority, writer);
  return {
    cancelInput: () => abort.abort(),
    authorizer,
    credentialOwner,
    issued,
    root,
    file,
    stores,
    policy,
    owner,
    command,
    grant,
    principal,
    writer,
    port,
    target,
    delivered,
    order,
    answer,
    liveAuthority,
    loseGrant: () => {
      currentOverride = { ...principal, permissions: new Set(["inputs.answer"]) };
    },
    verifyApproval,
    revokeOriginal: () => new CredentialStore({ file: credentialFile }).revoke(issued.credential.id),
    uncertainAppend: () => {
      uncertainAppend = true;
    },
  };
}

const identity = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
};
async function bridgeFixture() {
  const f = await fixture();
  let valid = true;
  let deadline = Date.now() + 60000;
  const reviews = new Map<string, RetainedScopedReview>();
  const owner = {
    sidecar: f.owner,
    live: f.port,
    disclosure: { requiredDisclosure: () => "complete" as const, reference: () => undefined },
    prepare: async () => {
      const r: RetainedScopedReview = {
        command: structuredClone(f.command),
        action: actionFixture(),
        scopeEvidenceRef: "synthetic:scope",
        reviewUntil: deadline,
        onceOptionId: "once",
        denyOptionId: "deny",
        projection: {},
        requiredReview: "passed",
        scope: {
          principal: "Synthetic principal",
          operation: "Read",
          resources: "Disposable fixture",
          environment: "Synthetic",
          lifetime: "One minute",
          limits: "Exact resource",
          authorizer: "Synthetic approval",
          coverage: "Synthetic only",
        },
      };
      reviews.set(r.command.approvalRecordRef, structuredClone(r));
      return r;
    },
    assertCurrent: (r: RetainedScopedReview) => {
      if (!valid || JSON.stringify(reviews.get(r.command.approvalRecordRef)) !== JSON.stringify(r))
        throw new Error("private review revoked");
      return undefined;
    },
    readAuthorityRevision: async () => "synthetic:authority",
    assertAuthorityRevision: () => undefined,
  };
  const table = scopedPermissionMethods(owner, identity, f.authorizer);
  const ctx = {
    orcaVersion: "synthetic",
    capabilities: [],
    liveAnswerAuthority: {
      actor: f.grant.actor,
      authorize: async () => {
        await f.grant.authorizeGrant();
      },
    },
  };
  const call = async (method: string, params: unknown, principal = f.principal) =>
    dispatch(
      JSON.stringify({ kind: "request", id: 1, method, params }),
      f.authorizer.guard(table),
      bindPrincipal(ctx, principal, { transport: "http" }),
    );
  const review = async () => {
    const r = await call("scopedPermissions.review", { target: identity, input: f.target });
    expect(r.ok).toBe(true);
    return (r as { result: { handle: string } }).result.handle;
  };
  return {
    ...f,
    table,
    ctx,
    call,
    review,
    invalidate: () => {
      valid = false;
    },
    expire: () => {
      deadline = 0;
    },
  };
}
it("saves exact reviewed bytes without answering, then requires a separate answer", async () => {
  const f = await bridgeFixture();
  const handle = await f.review();
  expect(await f.call("scopedPermissions.choose", { target: identity, handle, choice: "save" })).toMatchObject({
    ok: true,
    result: { outcome: "saved" },
  });
  expect(f.port.inspect(f.target)).toBe("pending");
  expect(await f.stores.events.readTypes("run", ["human.answered"])).toEqual([]);
  expect((await f.policy.read()).document.scopedRules.records[0]?.rule).toEqual(f.command.rule);
  expect(await f.call("scopedPermissions.choose", { target: identity, handle, choice: "save" })).toMatchObject({
    ok: false,
  });
  expect(await f.call("scopedPermissions.choose", { target: identity, handle, choice: "allow-once" })).toMatchObject({
    ok: true,
    result: { outcome: "answered" },
  });
  expect(await f.delivered).toBe("once");
});
it.each(["allow-once", "deny"])("%s never persists", async (choice) => {
  const f = await bridgeFixture();
  const handle = await f.review();
  await f.call("scopedPermissions.choose", { target: identity, handle, choice });
  expect((await f.policy.read()).document.scopedRules.records).toEqual([]);
  await f.delivered;
});
it("rejects public-command reconstruction and other callers", async () => {
  const f = await bridgeFixture();
  const handle = await f.review();
  expect(
    await f.call("scopedPermissions.choose", { target: identity, handle, choice: "save", rule: f.command.rule }),
  ).toMatchObject({ ok: false });
  expect(
    await f.call(
      "scopedPermissions.choose",
      { target: identity, handle, choice: "save" },
      { ...f.principal, id: "other", credentialId: "other" },
    ),
  ).toMatchObject({ ok: false });
  f.port.close();
  await f.delivered;
});
it.each(["cancel", "stale", "expiry", "workspace", "revoked"])("refuses %s without writing", async (reason) => {
  const f = await bridgeFixture();
  if (reason === "expiry") f.expire();
  if (reason === "expiry") {
    expect(await f.call("scopedPermissions.review", { target: identity, input: f.target })).toMatchObject({
      ok: false,
    });
  } else {
    const handle = await f.review();
    if (reason === "cancel") await f.call("scopedPermissions.cancel", { target: identity, handle });
    if (reason === "stale") f.invalidate();
    if (reason === "revoked") f.loseGrant();
    const r = await f.call("scopedPermissions.choose", {
      target: reason === "workspace" ? { ...identity, workspaceId: identity.instanceId } : identity,
      handle,
      choice: "save",
    });
    expect(r.ok && (r.result as { outcome: string }).outcome === "saved").toBe(false);
  }
  expect((await f.policy.read()).document.scopedRules.records).toEqual([]);
  f.port.close();
  await f.delivered;
});
it("lost publication acknowledgement is inspected without retry or callback replay", async () => {
  const f = await bridgeFixture();
  const handle = await f.review();
  faults.publication = true;
  expect(await f.call("scopedPermissions.choose", { target: identity, handle, choice: "save" })).toMatchObject({
    ok: true,
    result: { outcome: "uncertain" },
  });
  expect(await f.call("scopedPermissions.inspect", { target: identity, handle })).toMatchObject({
    ok: true,
    result: { retainedRule: true, outcome: "uncertain" },
  });
  expect(await f.call("scopedPermissions.choose", { target: identity, handle, choice: "save" })).toMatchObject({
    ok: false,
  });
  expect(await f.stores.events.readTypes("run", ["human.answered"])).toEqual([]);
  f.port.close();
  await f.delivered;
});

it("authenticates the real HTTP request path and returns only safe results", async () => {
  const f = await bridgeFixture();
  const d = await startDaemon({
    orcaVersion: "synthetic",
    capabilities: [],
    methods: f.table,
    auth: {
      mode: "token",
      credentials: f.credentialOwner,
      ownership: new OwnershipStore(),
      resolver: f.authorizer.resolver,
    },
  });
  try {
    const rpc = async (method: string, params: unknown, token = f.issued.token) => {
      const r = await fetch(`${d.url}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "request", id: 1, method, params }),
      });
      return (await r.json()) as { ok: boolean; result: { handle: string; outcome: string } };
    };
    expect((await rpc("scopedPermissions.review", { target: identity, input: f.target }, "invalid")).ok).toBe(false);
    const review = await rpc("scopedPermissions.review", { target: identity, input: f.target });
    expect(review.ok).toBe(true);
    expect(JSON.stringify(review)).not.toContain(f.command.approvalRecordRef);
    expect(JSON.stringify(review)).not.toContain(f.principal.credentialId);
    expect(
      (await rpc("scopedPermissions.choose", { target: identity, handle: review.result.handle, choice: "save" })).result
        .outcome,
    ).toBe("saved");
    expect(f.port.inspect(f.target)).toBe("pending");
  } finally {
    await d.close();
    f.port.close();
    await f.delivered;
  }
});
it("serializes double saves and refuses a stale sidecar revision", async () => {
  const f = await bridgeFixture();
  const handle = await f.review();
  const results = await Promise.all([
    f.call("scopedPermissions.choose", { target: identity, handle, choice: "save" }),
    f.call("scopedPermissions.choose", { target: identity, handle, choice: "save" }),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(await f.call("scopedPermissions.review", { target: identity, input: f.target })).toMatchObject({ ok: false });
  expect((await f.policy.read()).document.scopedRules.records).toHaveLength(1);
  f.port.close();
  await f.delivered;
});

it.each(["credential-revocation", "input-cancellation"])(
  "refuses %s across the final awaited policy read",
  async (reason) => {
    const f = await bridgeFixture();
    const handle = await f.review();
    faults.readTarget = f.file;
    faults.afterRead = async () => {
      if (reason === "credential-revocation") await f.revokeOriginal();
      else f.cancelInput();
    };
    const r = await f.call("scopedPermissions.choose", { target: identity, handle, choice: "save" });
    expect(r).toMatchObject({ ok: true, result: { outcome: "uncertain" } });
    expect((await f.policy.read()).document.scopedRules.records).toEqual([]);
    f.port.close();
    await f.delivered;
  },
);
