/** Inactive Linux service producer. No transport registration, native choices or qualification. */
import { isDeepStrictEqual } from "node:util";
import type { ActionEvidenceV1, ExecutionReceiptV1, MutationActor, PolicyPortV1 } from "@orca/core";
import {
  assertManagedTypedStoreBinding,
  type ManagedTypedStoreBinding,
  type ManagedTypedStoreProvider,
  type ScopedCaptureFacts,
  type ScopedCaptureTarget,
  type ScopedPermissionCapture,
  type ScopedPermissionCapturePort,
  type CreateScopedRule,
  type PendingScopedGrant,
  type PendingScopedExecution,
} from "@orca/agents";
import {
  assertOriginalDelivery,
  type HumanInputQuery,
  type LiveHumanInput,
  type LiveOriginalDelivery,
} from "@orca/engine";
import type { DisposableFileReadParameters } from "../../engine/src/disposable-file-read.js";
import type {
  createOwnedFileReadServiceForTest,
  TrustedOwnedReadInvocation,
  OwnedReadReviewPreview,
  PreparedOwnedRead,
  PrepareHumanRead,
} from "../../engine/src/owned-file-read-service.js";
import type { SyntheticFenceEvidence, SyntheticReadOwner } from "../../engine/src/synthetic-read-fence.js";

const refuse = (): never => {
  throw new Error("Original owned read capture unavailable");
};
const same = (a: unknown, b: unknown) => {
  if (!isDeepStrictEqual(a, b)) refuse();
};
const factsOf = (action: Pick<ActionEvidenceV1, "authority">): ScopedCaptureFacts => ({
  policyRevision: action.authority.currentPolicyRevision,
  authorityRevision: action.authority.authorityRevision,
  revocationEpoch: action.authority.revocationEpoch,
  leaseEpoch: action.authority.leaseEpoch,
});
// Runtime capability index only; no action JSON can register an owned prompt.
const ownedPrompts = new WeakMap<
  ScopedPermissionCapture,
  (action: ActionEvidenceV1) => { onceOptionId: string; denyOptionId: string }
>();
export function ownedReadInputOptions(capture: ScopedPermissionCapture, action: ActionEvidenceV1) {
  return ownedPrompts.get(capture)?.(action);
}

interface CaptureInput {
  target: ScopedCaptureTarget;
  query: HumanInputQuery;
  onceOptionId: string;
  denyOptionId: string;
  actor: MutationActor;
  owner: SyntheticReadOwner;
  parameters: DisposableFileReadParameters;
  policy: PolicyPortV1;
  evidence: SyntheticFenceEvidence;
}

/** Retains only facades created here by the actual bounded service, never caller action JSON.
 * The existing live query must already belong to the original callback. Its presentation
 * options do not become native action choices, review provenance or execution authority.
 */
export function ownedReadScopedCapture(options: {
  service: ReturnType<typeof createOwnedFileReadServiceForTest>;
  currentStore: ManagedTypedStoreProvider;
  live: LiveHumanInput;
  readCaptureFacts(actor: MutationActor): Promise<ScopedCaptureFacts>;
}) {
  const service = options.service,
    live = options.live;
  const currentStore = options.currentStore.bind(options);
  const readFacts = options.readCaptureFacts.bind(options);
  type EntryBase = {
    token: ScopedPermissionCapture;
    actor: MutationActor;
    target: ScopedCaptureTarget;
    query: HumanInputQuery;
    delivery: LiveOriginalDelivery;
    humanStarted: boolean;
    execution?: Promise<ExecutionReceiptV1>;
    binding: ManagedTypedStoreBinding;
    blocked: boolean;
    refreshed: boolean;
    parameters: DisposableFileReadParameters;
    clock(): number;
    ownerSignal: AbortSignal;
    pendingGrant?: { command: CreateScopedRule; capability: PendingScopedGrant };
  };
  type Entry = EntryBase &
    (
      | { kind: "legacy"; invocation: TrustedOwnedReadInvocation }
      | {
          kind: "intent";
          invocation: OwnedReadReviewPreview;
          prepared: PreparedOwnedRead;
          pendingExecution: PendingScopedExecution;
          previewReview: ReturnType<OwnedReadReviewPreview["reviewProvenance"]>;
        }
    );
  const entries = new Map<ScopedPermissionCapture, Entry>();
  const targets = new Set<string>(); // Lifetime tombstones; no callback replay or replacement.
  let binding: ManagedTypedStoreBinding | undefined;
  async function currentBinding() {
    const available = await currentStore();
    if (!available.available) return refuse();
    assertManagedTypedStoreBinding(available.binding);
    if (available.binding.store !== available.store || (binding && binding !== available.binding)) refuse();
    binding ??= available.binding;
    return binding;
  }
  function current(entry: Entry) {
    if (entry.blocked || entry.binding !== binding) refuse();
    assertManagedTypedStoreBinding(entry.binding);
    if (entry.humanStarted) assertOriginalDelivery(entry.delivery, entry.query);
    else {
      live.assertOriginalQuery(entry.query);
      if (!["pending", "accepting"].includes(live.inspect(entry.target))) refuse();
    }
    if (entry.kind === "intent") entry.pendingExecution.assertCurrent();
    else entry.invocation.assertCurrent();
  }
  function lookup(token: ScopedPermissionCapture) {
    const entry = entries.get(token);
    if (!entry) return refuse();
    return entry;
  }
  async function intake(input: CaptureInput) {
    const target = structuredClone(input.target),
      actor = { ...input.actor };
    const keys = ["resourceRef", "offset", "length"] as const;
    if (!input.parameters || Reflect.ownKeys(input.parameters).length !== keys.length) refuse();
    const parameters = Object.fromEntries(
      keys.map((key) => {
        const property = Object.getOwnPropertyDescriptor(input.parameters, key);
        if (!property || !Object.hasOwn(property, "value")) return refuse();
        return [key, property.value as unknown];
      }),
    ) as unknown as DisposableFileReadParameters;
    const originalOwner = input.owner,
      policy = input.policy,
      evidence = input.evidence;
    const clock = originalOwner.clock.now.bind(originalOwner.clock);
    const ownerSignal = originalOwner.signal;
    const query = input.query;
    const onceOptionId = input.onceOptionId,
      denyOptionId = input.denyOptionId;
    live.assertOriginalQuery(query);
    if (
      !onceOptionId ||
      !denyOptionId ||
      onceOptionId === denyOptionId ||
      !query.options.some((option) => option.id === onceOptionId) ||
      !query.options.some((option) => option.id === denyOptionId)
    )
      refuse();
    same(
      { ...query.live!.identity, runId: query.runId, stepRunId: query.stepRunId, requestId: query.requestId },
      target,
    );
    const key = JSON.stringify([
      target.instanceId,
      target.sessionId,
      target.turnId,
      target.invocationId,
      target.runId,
      target.stepRunId,
    ]);
    if (targets.size >= 128 || targets.has(key)) refuse();
    targets.add(key); // Claim before the first await, retaining failures as tombstones.
    const active = await currentBinding();
    const facts = await readFacts(actor); // MUST precede immutable service action capture.
    await currentBinding();
    const snapshot = originalOwner.snapshot();
    same(factsOf(snapshot), facts);
    same(snapshot.invocation.principalRef, actor.principalId);
    for (const field of ["instanceId", "sessionId", "turnId", "invocationId", "runId", "stepRunId"] as const)
      same(snapshot.invocation[field], target[field]);
    if (live.inspect(target) !== "pending") refuse();
    return {
      target,
      actor,
      parameters,
      originalOwner,
      policy,
      evidence,
      clock,
      ownerSignal,
      query,
      onceOptionId,
      denyOptionId,
      active,
      snapshot,
    };
  }
  const port = Object.freeze<ScopedPermissionCapturePort>({
    async read(target, active, facts) {
      await currentBinding();
      const entry = [...entries.values()].find((e) => isDeepStrictEqual(e.target, target)) ?? refuse();
      if (entry.binding !== active) refuse();
      same(factsOf(entry.invocation.action), facts);
      same(await readFacts({ ...entry.actor }), facts);
      await currentBinding();
      current(entry);
      return entry.token;
    },
    async forAction(action, active) {
      await currentBinding();
      const entry = [...entries.values()].find((e) => isDeepStrictEqual(e.invocation.action, action)) ?? refuse();
      // Historical previews never register an executable action for qualification.
      if (entry.kind === "intent") refuse();
      if (entry.binding !== active) refuse();
      same(await readFacts({ ...entry.actor }), factsOf(entry.invocation.action));
      await currentBinding();
      current(entry);
      return entry.token;
    },
    snapshot(token) {
      const entry = lookup(token);
      current(entry);
      const action = entry.invocation.action;
      if (action.workspaceRef.state !== "complete") return refuse();
      return {
        action,
        target: structuredClone(entry.target),
        binding: entry.binding,
        resourceWorkspaceRef: action.workspaceRef.value,
        actor: { ...entry.actor },
        review: entry.kind === "intent" ? structuredClone(entry.previewReview) : entry.invocation.reviewProvenance(),
        ...(entry.kind === "intent" ? { pendingExecution: entry.pendingExecution } : {}),
      };
    },
    assertCurrent(token, authority) {
      const entry = lookup(token);
      same(entry.invocation.action.authority, authority);
      current(entry);
      return undefined;
    },
    async retainGrantIntent(token, command) {
      const retainedCommand = structuredClone(command);
      const entry = lookup(token);
      await currentBinding();
      current(entry); // Retain historical scope only while the original action is live.
      if (entry.pendingGrant) {
        same(entry.pendingGrant.command, retainedCommand);
        entry.pendingGrant.capability.assertCurrent();
        return entry.pendingGrant.capability;
      }
      const action = entry.invocation.action;
      const parameters = structuredClone(entry.parameters);
      const capturedAt = entry.clock();
      if (
        !Number.isSafeInteger(capturedAt) ||
        capturedAt <= 0 ||
        !Number.isFinite(Date.parse(action.expiresAt)) ||
        capturedAt >= Date.parse(action.expiresAt)
      )
        refuse();
      const signal = AbortSignal.any([
        service.lifetimeSignal,
        entry.ownerSignal,
        entry.query.live!.signal,
        ...(entry.query.signal ? [entry.query.signal] : []),
      ]);
      const capability = Object.freeze<PendingScopedGrant>({
        capturedAt,
        signal,
        assertCurrent: (): undefined => {
          signal.throwIfAborted();
          if (
            entry.blocked ||
            entry.humanStarted ||
            entry.binding !== binding ||
            live.inspect(entry.target) !== "pending"
          )
            refuse();
          assertManagedTypedStoreBinding(entry.binding);
          live.assertOriginalQuery(entry.query);
          service.assertPendingResource(parameters);
          signal.throwIfAborted();
          return undefined;
        },
        retire: (): undefined => {
          entry.blocked = true;
          return entry.kind === "intent"
            ? service.retirePreparedHumanRead(entry.prepared)
            : service.retireInvocation(entry.invocation);
        },
      });
      capability.assertCurrent();
      entry.pendingGrant = { command: retainedCommand, capability };
      return capability;
    },
    async policyChanged(token, facts) {
      const entry = lookup(token);
      if (entry.kind === "intent") refuse();
      if (entry.blocked || entry.refreshed) refuse();
      // An uncertain transition cannot reopen this token, even if its acknowledgement is lost.
      entry.blocked = true;
      await currentBinding();
      same(await readFacts({ ...entry.actor }), facts);
      await currentBinding();
      const previous = factsOf(entry.invocation.action);
      same({ ...facts, policyRevision: previous.policyRevision }, previous);
      if (facts.policyRevision === previous.policyRevision || live.inspect(entry.target) !== "pending") refuse();
      if (entry.kind !== "legacy") return refuse();
      const fresh = service.refreshPolicyRevision(entry.invocation);
      same(factsOf(fresh.action), facts);
      fresh.assertCurrent();
      entry.invocation = fresh; // Retain the exact service facade; never rebuild action authority.
      entry.refreshed = true;
      entry.blocked = false;
    },
  });
  return Object.freeze({
    port,
    /** Save does not answer the old prompt. Tombstone its actual service facade. */
    retire(token: ScopedPermissionCapture): undefined {
      const entry = lookup(token);
      entry.blocked = true;
      return entry.kind === "intent"
        ? service.retirePreparedHumanRead(entry.prepared)
        : service.retireInvocation(entry.invocation);
    },
    /** Trusted execution owner retrieves the exact retained facade after policyChanged. */
    invocation(token: ScopedPermissionCapture) {
      const entry = lookup(token);
      current(entry);
      if (entry.kind === "intent") refuse();
      return entry.invocation;
    },
    /** Called by the original executor continuation after its explicit answer, never by Save.
     * Failed/uncertain completion consumes this attempt; duplicates share its exact outcome. */
    executeHumanDelivery(token: ScopedPermissionCapture, signal: AbortSignal): Promise<ExecutionReceiptV1> {
      const entry = lookup(token);
      if (entry.execution) return entry.execution;
      if (entry.blocked) return Promise.reject(new Error("Original owned read capture unavailable"));
      entry.humanStarted = true;
      entry.execution = (async () => {
        try {
          await currentBinding();
          if (entry.kind === "intent") return await service.executePreparedHumanRead(entry.prepared, signal);
          same(await readFacts({ ...entry.actor }), factsOf(entry.invocation.action));
          await currentBinding();
          const verdict = await entry.invocation.completeHumanDelivery(signal);
          current(entry);
          const permit = await entry.invocation.authorize(entry.invocation.action, verdict, signal);
          return await entry.invocation.dispatch(permit, signal);
        } finally {
          entry.blocked = true;
        }
      })();
      return entry.execution;
    },
    async capture(input: CaptureInput) {
      const {
        target,
        actor,
        parameters,
        originalOwner,
        policy,
        evidence,
        clock,
        ownerSignal,
        query,
        onceOptionId,
        denyOptionId,
        active,
      } = await intake(input);
      const invocation = service.capture(originalOwner, parameters, policy, evidence);
      invocation.assertCurrent();
      const token = Object.freeze({}) as ScopedPermissionCapture;
      live.assertOriginalQuery(query);
      const delivery = live.retainOriginalDelivery(query);
      invocation.bindHumanInput(delivery, query, actor, onceOptionId);
      entries.set(token, {
        kind: "legacy",
        token,
        invocation,
        actor,
        target,
        query,
        delivery,
        humanStarted: false,
        binding: active,
        blocked: false,
        refreshed: false,
        parameters,
        clock,
        ownerSignal,
      });
      ownedPrompts.set(token, (candidate) => {
        const entry = lookup(token);
        current(entry);
        same(candidate, entry.invocation.action);
        return { onceOptionId, denyOptionId };
      });
      return Object.freeze({ token, invocation });
    },
    /** Reserve the original callback before exposing a non-executable preview.
     * The trusted source supplies all non-expiry currentness checks formerly
     * performed by its finite owner, including actual policy/lease observations. */
    async captureIntent(
      input: CaptureInput & {
        executionWindowMs: number;
        authorizeExecution: PrepareHumanRead["authorizeExecution"];
        registerInvocation: PrepareHumanRead["registerInvocation"];
        assertIntentCurrent(): undefined;
      },
    ) {
      const window = input.executionWindowMs;
      const authorize = input.authorizeExecution.bind(input);
      const register = input.registerInvocation.bind(input);
      const assertIntent = input.assertIntentCurrent.bind(input);
      const {
        target,
        actor,
        parameters,
        originalOwner,
        policy,
        evidence,
        clock,
        ownerSignal,
        query,
        onceOptionId,
        denyOptionId,
        active,
        snapshot,
      } = await intake(input);
      if (assertIntent() !== undefined) refuse();
      live.assertOriginalQuery(query);
      const delivery = live.retainOriginalDelivery(query);
      const { expiresAt: _oldExpiry, ...intent } = structuredClone(snapshot);
      const prepared = service.prepareHumanRead({
        intent,
        parameters,
        delivery,
        query,
        actor,
        onceOptionId,
        executionWindowMs: window,
        authorizeExecution: authorize,
        registerInvocation: register,
      });
      const preview = service.reviewPreparedHumanRead(prepared, originalOwner, policy, evidence);
      preview.assertCurrent();
      const previewReview = structuredClone(preview.reviewProvenance());
      const token = Object.freeze({}) as ScopedPermissionCapture;
      const signal = AbortSignal.any([
        service.lifetimeSignal,
        ownerSignal,
        query.live!.signal,
        ...(query.signal ? [query.signal] : []),
      ]);
      const pendingExecution = Object.freeze<PendingScopedExecution>({
        signal,
        executionWindowMs: window,
        assertCurrent: (): undefined => {
          signal.throwIfAborted();
          if (
            entry.blocked ||
            entry.humanStarted ||
            entry.binding !== binding ||
            !["pending", "accepting"].includes(live.inspect(target))
          )
            refuse();
          assertManagedTypedStoreBinding(active);
          live.assertOriginalQuery(query);
          service.assertPreparedHumanRead(prepared);
          if (assertIntent() !== undefined) refuse();
          assertManagedTypedStoreBinding(active);
          service.assertPreparedHumanRead(prepared);
          signal.throwIfAborted();
          if (entry.blocked || entry.humanStarted || !["pending", "accepting"].includes(live.inspect(target))) refuse();
          return undefined;
        },
      });
      const entry: Extract<Entry, { kind: "intent" }> = {
        kind: "intent",
        token,
        invocation: preview,
        prepared,
        pendingExecution,
        previewReview,
        actor,
        target,
        query,
        delivery,
        humanStarted: false,
        binding: active,
        blocked: false,
        refreshed: false,
        parameters,
        clock,
        ownerSignal,
      };
      pendingExecution.assertCurrent();
      entries.set(token, entry);
      ownedPrompts.set(token, (candidate) => {
        current(entry);
        same(candidate, preview.action);
        return { onceOptionId, denyOptionId };
      });
      return Object.freeze({ token, preview });
    },
  });
}
