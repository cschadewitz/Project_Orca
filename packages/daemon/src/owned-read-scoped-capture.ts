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
  type Entry = {
    token: ScopedPermissionCapture;
    invocation: TrustedOwnedReadInvocation;
    actor: MutationActor;
    target: ScopedCaptureTarget;
    query: HumanInputQuery;
    delivery: LiveOriginalDelivery;
    humanStarted: boolean;
    execution?: Promise<ExecutionReceiptV1>;
    binding: ManagedTypedStoreBinding;
    blocked: boolean;
    refreshed: boolean;
  };
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
    entry.invocation.assertCurrent();
  }
  function lookup(token: ScopedPermissionCapture) {
    const entry = entries.get(token);
    if (!entry) return refuse();
    return entry;
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
        review: entry.invocation.reviewProvenance(),
      };
    },
    assertCurrent(token, authority) {
      const entry = lookup(token);
      same(entry.invocation.action.authority, authority);
      current(entry);
      return undefined;
    },
    async policyChanged(token, facts) {
      const entry = lookup(token);
      if (entry.blocked || entry.refreshed) refuse();
      // An uncertain transition cannot reopen this token, even if its acknowledgement is lost.
      entry.blocked = true;
      await currentBinding();
      same(await readFacts({ ...entry.actor }), facts);
      await currentBinding();
      const previous = factsOf(entry.invocation.action);
      same({ ...facts, policyRevision: previous.policyRevision }, previous);
      if (facts.policyRevision === previous.policyRevision || live.inspect(entry.target) !== "pending") refuse();
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
    /** Trusted execution owner retrieves the exact retained facade after policyChanged. */
    invocation(token: ScopedPermissionCapture) {
      const entry = lookup(token);
      current(entry);
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
    async capture(input: {
      target: ScopedCaptureTarget;
      query: HumanInputQuery;
      /** Actual original owned-I/O prompt meaning, supplied by its trusted callback owner. */
      onceOptionId: string;
      denyOptionId: string;
      actor: MutationActor;
      owner: SyntheticReadOwner;
      parameters: DisposableFileReadParameters;
      policy: PolicyPortV1;
      evidence: SyntheticFenceEvidence;
    }) {
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
      const invocation = service.capture(originalOwner, parameters, policy, evidence);
      invocation.assertCurrent();
      const token = Object.freeze({}) as ScopedPermissionCapture;
      live.assertOriginalQuery(query);
      const delivery = live.retainOriginalDelivery(query);
      invocation.bindHumanInput(delivery, query, actor, onceOptionId);
      entries.set(token, {
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
      });
      ownedPrompts.set(token, (candidate) => {
        const entry = lookup(token);
        current(entry);
        same(candidate, entry.invocation.action);
        return { onceOptionId, denyOptionId };
      });
      return Object.freeze({ token, invocation });
    },
  });
}
