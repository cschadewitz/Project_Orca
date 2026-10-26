/** Inactive integration owner. Protected approval records never restore callbacks or permits. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  OrcaError,
  strictDecisionBinding,
  type ActionEvidenceV1,
  type MutationActor,
  type StrictPermissionRule,
} from "@orca/core";
import {
  assertManagedTypedStoreBinding,
  strictPermissionRuleRevision,
  validStrictPermissionRule,
  type CreateScopedRule,
  type ManagedTypedStoreBinding,
  type ManagedTypedStoreProvider,
  type ScopedCaptureFacts,
  type ScopedPermissionCapture,
  type ScopedPermissionCapturePort,
  type TypedRuleRecord,
  type TypedSidecarOwnerPorts,
  type TypedSidecarSnapshot,
} from "@orca/agents";
import {
  lapsed,
  LeaseSchema,
  ProtectedEventStore,
  type EventStore,
  type ExecutionStore,
  type Lease,
  type LeaseStore,
} from "@orca/store";
import { ScopedPermissionScopeSchema } from "@orca/protocol";
import type { LiveDecisionTarget, LiveHumanInput } from "@orca/engine";
import { ownedReadInputOptions } from "./owned-read-scoped-capture.js";
import {
  projectGuardDecision,
  type GuardDecisionView,
  type GuardDecisionProjectionInput,
  type GuardProjectionDisclosure,
} from "../../protocol/src/guard-decision-projection.js";
import type { CredentialStore } from "./auth/credentials.js";
import { PermissionSchema, ResourceScopeSchema } from "./auth/principal.js";
import type { RetainedScopedReview, ScopedPermissionOwner } from "./scoped-permission-bridge.js";

type Kind = Parameters<GuardProjectionDisclosure["reference"]>[0];
/** An independently trusted destination owner must approve the exact display text and
 * reference associations. This port cannot issue execution, grant or capture authority.
 */
export interface ScopedDisclosureOwner {
  approve(
    capture: ScopedPermissionCapture,
    command: CreateScopedRule,
    projection: GuardDecisionProjectionInput,
  ): Promise<{
    scope: z.infer<typeof ScopedPermissionScopeSchema>;
    references: readonly { kind: Kind; privateRef: string }[];
  }>;
}
const referenceSchema = z.strictObject({
  kind: z.enum(["coverage", "rule", "revision", "authorizer", "review", "receipt", "observation"]),
  privateRef: z.string().min(1),
  id: z.uuid(),
});
const actorSchema = z.strictObject({ principalId: z.string().min(1), credentialId: z.string().min(1) });
const credentialFactsSchema = actorSchema.extend({
  permissions: z.array(PermissionSchema),
  scope: ResourceScopeSchema,
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});
const bindingSchema = z.strictObject({
  workspaceRef: z.string().min(1),
  rootBindingRef: z.string().min(1),
  enrollmentRef: z.string().min(1),
});
const targetSchema = z.strictObject({
  instanceId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  invocationId: z.string(),
  runId: z.string(),
  stepRunId: z.string(),
  requestId: z.string(),
});
function fail(): never {
  throw new OrcaError("CONFIG_STALE", "Protected scoped review is unavailable.");
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const leaseEpochOf = (lease: Lease) =>
  digest([lease.resource, lease.holder, lease.guardedId, lease.acquiredAt, lease.pid, lease.guardedHost ?? lease.host]);
const same = (left: unknown, right: unknown) => {
  if (!isDeepStrictEqual(left, right)) fail();
};
const factsOf = (action: ActionEvidenceV1): ScopedCaptureFacts => ({
  policyRevision: action.authority.currentPolicyRevision,
  authorityRevision: action.authority.authorityRevision,
  revocationEpoch: action.authority.revocationEpoch,
  leaseEpoch: action.authority.leaseEpoch,
});
const identity = (binding: ManagedTypedStoreBinding) => ({
  workspaceRef: binding.workspaceRef,
  rootBindingRef: binding.rootBindingRef,
  enrollmentRef: binding.enrollmentRef,
});
/** Exact scope only. A missing fact, extra resource, wider environment or delegation
 * cannot be smuggled into a saved grant by presentation strings or a supplied rule.
 */
function matchFor(action: ActionEvidenceV1): StrictPermissionRule["match"] {
  if (
    action.version !== 1 ||
    !action.bindingRef ||
    !action.actionId ||
    !action.authority.capturedGeneration ||
    action.effectiveCwd.state !== "complete" ||
    action.workspaceRef.state !== "complete" ||
    action.resources.state !== "complete" ||
    !action.resources.value.length ||
    action.environmentAndCredentialRefs.state !== "complete"
  )
    return fail();
  const invocation = action.invocation;
  return {
    principalRef: invocation.principalRef,
    agentId: invocation.agentId,
    hostId: invocation.hostId,
    runnerId: invocation.runnerId,
    operation: action.operation,
    profileRef: action.profileRef,
    coverageId: action.coverage.coverageId,
    effectiveCwd: action.effectiveCwd.value,
    workspaceRef: action.workspaceRef.value,
    resources: structuredClone(action.resources.value),
    environmentAndCredentialRefs: structuredClone(action.environmentAndCredentialRefs.value),
  };
}
function verified(action: ActionEvidenceV1): void {
  const coverage = action.coverage;
  if (
    coverage.level !== "verified-per-execution" ||
    !coverage.evidence.sourceRefs.length ||
    !coverage.evidence.installedRefs.length ||
    !coverage.evidence.independentlyObservedEffects ||
    coverage.negotiatedHook.state !== "complete" ||
    coverage.protectedConfiguration.state !== "complete"
  )
    fail();
}
const actionSchema = z.custom<ActionEvidenceV1>((value) => {
  try {
    const action = value as ActionEvidenceV1;
    const match = matchFor(action);
    return (
      Object.values(action.invocation).every((v) => typeof v === "string" && !!v) &&
      Object.values(action.authority).every((v) => typeof v === "string" && !!v) &&
      validStrictPermissionRule({
        ruleId: "validation",
        ruleRevision: "validation",
        status: "approved",
        notBefore: "2000-01-01T00:00:00.000Z",
        expiresAt: "2001-01-01T00:00:00.000Z",
        match,
        decision: "allow",
      })
    );
  } catch {
    return false;
  }
});
const ruleSchema = z.custom<StrictPermissionRule>(validStrictPermissionRule);
const recordSchema = z.strictObject({
  version: z.literal(1),
  choice: z.literal("save"),
  requiredReview: z.literal("passed"),
  acceptedAt: z.iso.datetime(),
  credential: credentialFactsSchema,
  lease: LeaseSchema,
  binding: bindingSchema,
  actor: actorSchema,
  target: targetSchema,
  command: z.strictObject({ rule: ruleSchema, expectedRevision: z.string(), approvalRecordRef: z.string() }),
  action: actionSchema,
  resourceWorkspaceRef: z.string().min(1),
  scopeEvidenceRef: z.uuid(),
  authorityRevision: z.string().min(1),
  scope: ScopedPermissionScopeSchema,
  projection: z.record(z.string(), z.unknown()),
  references: z.array(referenceSchema).max(256),
  reviewSourceRefs: z.array(z.string().min(1)).min(1),
});
type Approval = z.infer<typeof recordSchema>;
type Entry = {
  review: RetainedScopedReview;
  actor: MutationActor;
  capture: ScopedPermissionCapture;
  binding: ManagedTypedStoreBinding;
  target: LiveDecisionTarget;
  references: Approval["references"];
  reviewSourceRefs: string[];
  state: "review" | "saving" | "approved" | "retired" | "uncertain";
  assertProofCurrent?: () => undefined;
};
export interface ProtectedScopedPermissionOptions {
  readonly currentStore: ManagedTypedStoreProvider;
  readonly live: LiveHumanInput;
  readonly captures: ScopedPermissionCapturePort;
  readonly disclosure: ScopedDisclosureOwner;
  readonly credentials: CredentialStore;
  readonly leases: LeaseStore;
  readonly lease: Lease;
  readonly execution: ExecutionStore;
  readonly events: EventStore;
}

/** Concrete file/auth/lease adapter. No default capture/disclosure/build owner is supplied. */
export function protectedScopedPermissionOwner(options: ProtectedScopedPermissionOptions): ScopedPermissionOwner & {
  readonly qualify: TypedSidecarOwnerPorts["qualify"];
  readCaptureFacts(actor: MutationActor): Promise<ScopedCaptureFacts>;
  inspectRule(
    ruleId: string,
    actor: MutationActor,
  ): Promise<{
    scope: z.infer<typeof ScopedPermissionScopeSchema>;
    decision: GuardDecisionView;
  }>;
} {
  // Retain original services/functions; later mutation of a composition object cannot replace authority.
  const provider = options.currentStore,
    live = options.live,
    credentials = options.credentials;
  const leases = options.leases,
    lease = structuredClone(options.lease),
    execution = options.execution,
    events = options.events;
  if (!(events instanceof ProtectedEventStore)) fail();
  const captures = Object.freeze({
    read: options.captures.read.bind(options.captures),
    snapshot: options.captures.snapshot.bind(options.captures),
    forAction: options.captures.forAction.bind(options.captures),
    assertCurrent: options.captures.assertCurrent.bind(options.captures),
    policyChanged: options.captures.policyChanged.bind(options.captures),
  });
  const approveDisclosure = options.disclosure.approve.bind(options.disclosure);
  const entries = new Map<string, Entry>();
  const lineages = new Map<
    string,
    {
      target: LiveDecisionTarget;
      invocation: ActionEvidenceV1["invocation"];
      capturedGeneration: string;
      actor: MutationActor;
      resourceWorkspaceRef: string;
      saved?: boolean;
      blocked?: boolean;
    }
  >();
  let retainedBinding: ManagedTypedStoreBinding | undefined;
  let held: Entry | undefined;
  let observedLease: Lease | undefined;
  const now = () => leases.clock?.now() ?? Date.now();
  async function binding() {
    const value = await provider();
    if (!value.available) return fail();
    assertManagedTypedStoreBinding(value.binding);
    if (value.store !== value.binding.store || (retainedBinding && retainedBinding !== value.binding)) fail();
    retainedBinding ??= value.binding;
    return value.binding;
  }
  function credential(actor: MutationActor) {
    if (!actor.credentialId) return fail();
    const value = credentials.current(actor.credentialId);
    if (!value.ok || value.principal.id !== actor.principalId || !value.principal.permissions.has("permissions.grant"))
      return fail();
    const info = credentials.list().find((record) => record.id === actor.credentialId);
    if (!info || info.principal !== actor.principalId || info.revokedAt) return fail();
    return {
      principalId: value.principal.id,
      credentialId: info.id,
      permissions: [...value.principal.permissions].sort(),
      scope: value.principal.scope,
      expiresAt: info.expiresAt ?? null,
      createdAt: info.createdAt,
    };
  }
  function currentFacts(
    actor: MutationActor,
    policyRevision: string,
    active: ManagedTypedStoreBinding,
  ): ScopedCaptureFacts {
    assertManagedTypedStoreBinding(active);
    if (!observedLease || lapsed(observedLease, now())) return fail();
    const revocationEpoch = digest(credential(actor));
    const leaseEpoch = leaseEpochOf(observedLease);
    return {
      policyRevision,
      revocationEpoch,
      leaseEpoch,
      authorityRevision: digest([identity(active), revocationEpoch, leaseEpoch]),
    };
  }
  async function facts(actor: MutationActor, revision: string, active: ManagedTypedStoreBinding) {
    const current = await leases.get(lease.resource);
    if (
      !current ||
      !lease.guardedId ||
      current.guardedId !== lease.guardedId ||
      current.holder !== lease.holder ||
      current.resource !== lease.resource ||
      lapsed(current, now())
    )
      return fail();
    observedLease = structuredClone(current);
    return currentFacts(actor, revision, active);
  }
  function entryFor(review: RetainedScopedReview, actor: MutationActor) {
    const entry = entries.get(review.command.approvalRecordRef);
    if (!entry || entry.state === "retired" || entry.state === "uncertain") return fail();
    same(entry.review, review);
    same(entry.actor, actor);
    return entry;
  }
  function assertEntry(entry: Entry): undefined {
    if (now() >= entry.review.reviewUntil || !["pending", "accepting"].includes(live.inspect(entry.target))) fail();
    const snapshot = captures.snapshot(entry.capture);
    if (snapshot.binding !== entry.binding) fail();
    same(snapshot.target, entry.target);
    same(snapshot.action, entry.review.action);
    if (entry.review.action.workspaceRef.state !== "complete") fail();
    same(snapshot.resourceWorkspaceRef, entry.review.action.workspaceRef.value);
    same(snapshot.review, { result: entry.review.requiredReview, sourceRefs: entry.reviewSourceRefs });
    same(currentFacts(entry.actor, entry.review.command.expectedRevision, entry.binding), factsOf(snapshot.action));
    if (captures.assertCurrent(entry.capture, snapshot.action.authority) !== undefined) fail();
    return undefined;
  }
  const disclosure: GuardProjectionDisclosure = Object.freeze({
    requiredDisclosure(projection: unknown) {
      // Only exact approved snapshots retained for this owner can expose references.
      return [...entries.values()].some(
        (e) => e.state !== "retired" && e.state !== "uncertain" && isDeepStrictEqual(e.review.projection, projection),
      )
        ? "complete"
        : "unavailable";
    },
    reference(kind: Kind, privateRef: string) {
      const refs = [...entries.values()]
        .filter((e) => e.state !== "retired" && e.state !== "uncertain")
        .flatMap((e) => e.references)
        .filter((r) => r.kind === kind && r.privateRef === privateRef);
      return refs.length === 1 ? { id: refs[0]!.id } : undefined;
    },
  });
  async function readApproval(record: TypedRuleRecord): Promise<Approval> {
    // Locator only. Parsing a reference never restores a capability or confers authority.
    let locator: unknown;
    try {
      locator = JSON.parse(record.approvalRecordRef);
    } catch {
      return fail();
    }
    const [runId, ref] = z.tuple([z.string().min(1), z.uuid()]).parse(locator);
    const marker = (await events.readTypes(runId, ["agent.permission"])).filter(
      (event) => event.type === "agent.permission" && event.payload.scopedApprovalRef === ref,
    );
    if (marker.length !== 1 || !marker[0]!.executionPayloadRef) return fail();
    const payload = await execution.getPayload(runId, marker[0]!.executionPayloadRef, "agent.permission");
    const parsed = recordSchema.parse((payload as { entry?: unknown }).entry);
    same((payload as { scopedApprovalRef?: unknown }).scopedApprovalRef, ref);
    same((payload as { stepRunId?: unknown }).stepRunId, parsed.target.stepRunId);
    if (
      marker[0]!.type !== "agent.permission" ||
      marker[0].payload.stepRunId !== parsed.target.stepRunId ||
      parsed.target.runId !== runId
    )
      fail();
    same(parsed.command.rule, record.rule);
    same(parsed.actor, record.actor);
    same(parsed.command.approvalRecordRef, record.approvalRecordRef);
    same(parsed.scopeEvidenceRef, record.scopeEvidenceRef);
    same(parsed.authorityRevision, record.authorityRevision);
    same(parsed.action.authority.currentPolicyRevision, parsed.command.expectedRevision);
    same(parsed.action.authority.authorityRevision, parsed.authorityRevision);
    const revoked = digest(parsed.credential),
      leaseEpoch = leaseEpochOf(parsed.lease);
    same(parsed.actor, { principalId: parsed.credential.principalId, credentialId: parsed.credential.credentialId });
    same(parsed.action.authority.revocationEpoch, revoked);
    same(parsed.action.authority.leaseEpoch, leaseEpoch);
    same(parsed.authorityRevision, digest([parsed.binding, revoked, leaseEpoch]));
    const accepted = Date.parse(parsed.acceptedAt);
    if (
      !parsed.lease.guardedId ||
      parsed.lease.resource !== `run:${parsed.target.runId}` ||
      accepted >= Date.parse(parsed.lease.renewedAt) + (parsed.lease.guardedTtlMs ?? parsed.lease.ttlMs) ||
      (parsed.credential.expiresAt && accepted >= Date.parse(parsed.credential.expiresAt)) ||
      accepted >= Date.parse(parsed.command.rule.expiresAt) ||
      accepted >= Date.parse(parsed.action.expiresAt)
    )
      fail();
    same(parsed.command.rule.match, matchFor(parsed.action));
    if (parsed.action.workspaceRef.state !== "complete") fail();
    same(parsed.action.workspaceRef.value, parsed.resourceWorkspaceRef);
    if (marker[0].type !== "agent.permission") fail();
    same(marker[0].payload.sessionId, parsed.action.invocation.sessionId);
    same(marker[0].payload.title, "create a scoped rule");
    same(marker[0].payload.decision, "scoped-rule-save-accepted");
    same(parsed.actor.principalId, parsed.action.invocation.principalRef);
    for (const key of ["instanceId", "sessionId", "turnId", "invocationId", "runId", "stepRunId"] as const)
      same(parsed.target[key], parsed.action.invocation[key]);
    if (parsed.command.rule.delegation) fail();
    verified(parsed.action);
    if (parsed.command.rule.ruleRevision !== strictPermissionRuleRevision(parsed.command.rule)) fail();
    return parsed;
  }
  const owner: ScopedPermissionOwner = {
    currentStore: provider,
    live,
    disclosure,
    async prepare(target, actor, snapshot, active) {
      const original = await binding();
      if (active !== original || lease.resource !== `run:${target.runId}`) fail();
      const observed = await facts(actor, snapshot.revision, active);
      const capture = await captures.read(structuredClone(target), active, structuredClone(observed));
      const source = captures.snapshot(capture);
      if (source.binding !== active) fail();
      same(source.target, target);
      same(factsOf(source.action), observed);
      same(source.actor, actor);
      if (source.action.workspaceRef.state !== "complete") fail();
      same(source.action.workspaceRef.value, source.resourceWorkspaceRef);
      same(source.action.invocation.principalRef, actor.principalId);
      for (const key of ["instanceId", "sessionId", "turnId", "invocationId", "runId", "stepRunId"] as const)
        same(source.action.invocation[key], target[key]);
      const action = structuredClone(source.action);
      const lineageKey = JSON.stringify(targetSchema.parse(target));
      const originalCapture = lineages.get(lineageKey);
      if (originalCapture) {
        if (originalCapture.blocked) fail();
        same(originalCapture.invocation, action.invocation);
        same(originalCapture.capturedGeneration, action.authority.capturedGeneration);
        same(originalCapture.actor, actor);
        same(originalCapture.resourceWorkspaceRef, source.resourceWorkspaceRef);
      }
      const ends = Math.min(Date.parse(action.expiresAt), now() + 60000);
      if (!Number.isFinite(ends) || ends <= now()) fail();
      const once = action.offeredChoices.find(
        (choice) =>
          choice.kind === "allow_once" &&
          choice.effect === "this-invocation" &&
          choice.qualificationRef.state === "complete",
      );
      const deny = action.offeredChoices.find(
        (choice) =>
          choice.kind === "reject_once" &&
          choice.effect === "this-invocation" &&
          choice.qualificationRef.state === "complete",
      );
      let onceOptionId = once?.optionId,
        denyOptionId = deny?.optionId;
      if (!onceOptionId || !denyOptionId) {
        // Owned I/O has an actual original owner prompt, not fabricated ACP choices.
        // Only the closed producer can resolve it, and installed coverage remains mandatory.
        verified(action);
        const owned = ownedReadInputOptions(capture, source.action);
        if (!owned) return fail();
        ({ onceOptionId, denyOptionId } = owned);
      }
      const rule = {
        ruleId: randomUUID(),
        ruleRevision: "",
        status: "approved" as const,
        notBefore: new Date(now()).toISOString(),
        expiresAt: new Date(ends).toISOString(),
        match: matchFor(action),
        decision: "allow" as const,
      };
      rule.ruleRevision = strictPermissionRuleRevision(rule);
      const command: CreateScopedRule = {
        rule,
        expectedRevision: snapshot.revision,
        approvalRecordRef: JSON.stringify([target.runId, randomUUID()]),
      };
      // Disclosure approves visibility; it cannot manufacture policy verdicts, current
      // execution authority, delivery/dispatch/effect claims or a permit.
      const projection: GuardDecisionProjectionInput = {
        coverage: structuredClone(action.coverage),
        currentAuthority: { state: "unknown", reason: "no-execution-decision" },
        expiresAt: { state: "complete", value: action.expiresAt },
        revocation: { state: "complete", value: "active" },
      };
      const approved = await approveDisclosure(capture, structuredClone(command), structuredClone(projection));
      const scope = ScopedPermissionScopeSchema.parse(approved.scope);
      const references = approved.references.map((r) => referenceSchema.parse({ ...r, id: randomUUID() }));
      if (
        references.length > 256 ||
        new Set(references.map((r) => JSON.stringify([r.kind, r.privateRef]))).size !== references.length
      )
        fail();
      const review: RetainedScopedReview = {
        command,
        action,
        scopeEvidenceRef: randomUUID(),
        reviewUntil: ends,
        onceOptionId,
        denyOptionId,
        projection,
        scope,
        requiredReview: source.review.result,
      };
      const entry: Entry = {
        review: structuredClone(review),
        actor: structuredClone(actor),
        capture,
        binding: active,
        target: structuredClone(target),
        references,
        reviewSourceRefs: [...source.review.sourceRefs],
        state: "review",
      };
      assertEntry(entry);
      if ((await active.store.read()).revision !== snapshot.revision) fail();
      await binding();
      await facts(actor, snapshot.revision, active);
      assertEntry(entry);
      for (const [key, value] of entries)
        if (value.review.reviewUntil <= now() && value.state !== "saving") entries.delete(key);
      if (entries.size >= 1024) fail();
      for (const [key, value] of lineages)
        if (!["pending", "accepting"].includes(live.inspect(value.target))) lineages.delete(key);
      if (!originalCapture && lineages.size >= 1024) fail();
      if (!originalCapture)
        lineages.set(lineageKey, {
          target: structuredClone(target),
          invocation: structuredClone(action.invocation),
          capturedGeneration: action.authority.capturedGeneration,
          actor: structuredClone(actor),
          resourceWorkspaceRef: source.resourceWorkspaceRef,
        });
      entries.set(review.command.approvalRecordRef, entry);
      return structuredClone(review);
    },
    assertCurrent(review, actor) {
      return assertEntry(entryFor(review, actor));
    },
    async readAuthorityRevision(review, actor) {
      const entry = entryFor(review, actor);
      await binding();
      const value = await facts(actor, review.command.expectedRevision, entry.binding);
      assertEntry(entry);
      return value.authorityRevision;
    },
    assertAuthorityRevision(review, actor, revision) {
      const entry = entryFor(review, actor);
      if (held !== entry) return fail();
      assertEntry(entry);
      if (!entry.assertProofCurrent || entry.assertProofCurrent() !== undefined) fail();
      same(currentFacts(actor, review.command.expectedRevision, entry.binding).authorityRevision, revision);
      return undefined;
    },
    async withSaveOwnership(review, actor, work) {
      const entry = entryFor(review, actor);
      if (entry.state !== "review") return fail();
      const lineage = lineages.get(JSON.stringify(targetSchema.parse(entry.target)));
      if (!lineage || lineage.saved || lineage.blocked) return fail();
      entry.state = "saving";
      try {
        return await leases.withOwnership(lease, async () => {
          if (held) return fail();
          held = entry;
          try {
            if ((await entry.binding.store.read()).revision !== review.command.expectedRevision) fail();
            await facts(actor, review.command.expectedRevision, entry.binding);
            assertEntry(entry);
            const result = await work();
            lineage.saved = true;
            return result;
          } finally {
            held = undefined;
          }
        });
      } catch (error) {
        entry.state = "uncertain";
        lineage.blocked = true;
        throw error;
      }
    },
    async recordApproval(review, actor) {
      const entry = entryFor(review, actor);
      if (
        held !== entry ||
        entry.state !== "saving" ||
        review.requiredReview !== "passed" ||
        !entry.reviewSourceRefs.length ||
        live.inspect(entry.target) !== "pending"
      )
        fail();
      assertEntry(entry);
      verified(review.action);
      if (!(await execution.getInputs(entry.target.runId))) fail();
      await facts(actor, review.command.expectedRevision, entry.binding);
      assertEntry(entry);
      const [, ref] = z.tuple([z.string(), z.uuid()]).parse(JSON.parse(review.command.approvalRecordRef));
      const approval: Approval = recordSchema.parse({
        version: 1,
        choice: "save",
        requiredReview: "passed",
        acceptedAt: new Date(now()).toISOString(),
        credential: credential(actor),
        lease: observedLease,
        binding: identity(entry.binding),
        actor,
        target: entry.target,
        command: review.command,
        action: review.action,
        resourceWorkspaceRef: captures.snapshot(entry.capture).resourceWorkspaceRef,
        scopeEvidenceRef: review.scopeEvidenceRef,
        authorityRevision: review.action.authority.authorityRevision,
        scope: review.scope,
        projection: review.projection,
        references: entry.references,
        reviewSourceRefs: entry.reviewSourceRefs,
      });
      const payload = {
        stepRunId: entry.target.stepRunId,
        sessionId: review.action.invocation.sessionId,
        title: "create a scoped rule",
        decision: "scoped-rule-save-accepted",
        scopedApprovalRef: ref,
        entry: approval,
      };
      // No answer, native delivery or execution permit is created by this marker.
      // ProtectedEventStore writes the encrypted payload before the scrubbed public marker.
      await events.append({ type: "agent.permission", runId: entry.target.runId, payload });
      await facts(actor, review.command.expectedRevision, entry.binding);
      assertEntry(entry);
      await readApproval({
        rule: review.command.rule,
        actor,
        approvalRecordRef: review.command.approvalRecordRef,
        scopeEvidenceRef: review.scopeEvidenceRef,
        authorityRevision: review.action.authority.authorityRevision,
      });
      assertEntry(entry);
      entry.state = "approved";
    },
    async verifyApproval(review, actor) {
      const entry = entryFor(review, actor);
      if (held !== entry || entry.state !== "approved" || !execution.observe) return fail();
      const observation = await execution.observe(
        () =>
          readApproval({
            rule: review.command.rule,
            actor,
            approvalRecordRef: review.command.approvalRecordRef,
            scopeEvidenceRef: review.scopeEvidenceRef,
            authorityRevision: review.action.authority.authorityRevision,
          }),
        { maxRecords: 256 },
      );
      if (!observation.assertUnchanged) return fail();
      same(observation.value.binding, identity(entry.binding));
      await observation.verifyUnchanged();
      assertEntry(entry);
      entry.assertProofCurrent = observation.assertUnchanged.bind(observation);
      return { scopeEvidenceRef: review.scopeEvidenceRef };
    },
    async policySaved(review, actor) {
      const entry = entryFor(review, actor);
      if (entry.state !== "approved") fail();
      // Retire before any await. Failed handoff is uncertain and cannot revive old attempts.
      for (const previous of entries.values())
        if (isDeepStrictEqual(previous.target, entry.target)) previous.state = "retired";
      const active = await binding();
      const snapshot = await active.store.read();
      if (snapshot.revision === review.command.expectedRevision) fail();
      const observed = await facts(actor, snapshot.revision, active);
      await captures.policyChanged(entry.capture, observed);
    },
  };
  return Object.freeze({
    ...owner,
    async inspectRule(ruleId: string, actor: MutationActor) {
      const active = await binding();
      credential(actor);
      const snapshot = await active.store.read();
      const record = snapshot.document.scopedRules.records.find((r) => r.rule.ruleId === ruleId);
      if (
        !record ||
        record.rule.status !== "approved" ||
        now() < Date.parse(record.rule.notBefore) ||
        now() >= Date.parse(record.rule.expiresAt) ||
        !execution.observe
      )
        return fail();
      const observation = await execution.observe(() => readApproval(record), { maxRecords: 256 });
      if (!observation.assertUnchanged) return fail();
      const proof = observation.value;
      same(proof.actor, actor);
      same(proof.binding, identity(active));
      // Historical Save proves approval, never current execution authority or an effect.
      const projection: GuardDecisionProjectionInput = {
        coverage: proof.action.coverage,
        verdict: {
          ...strictDecisionBinding(proof.action),
          outcome: "allow",
          authorizedBy: {
            kind: "rule",
            ruleId: record.rule.ruleId,
            ruleRevision: record.rule.ruleRevision,
          },
        },
        currentAuthority: { state: "unknown", reason: "requires-current-invocation" },
        authorityKind: { state: "complete", value: "stored-rule" },
        expiresAt: { state: "complete", value: record.rule.expiresAt },
        revocation: { state: "complete", value: "active" },
      };
      const safe: GuardProjectionDisclosure = {
        requiredDisclosure: (candidate) => (isDeepStrictEqual(candidate, projection) ? "complete" : "unavailable"),
        reference: (kind, privateRef) => {
          const matches = proof.references.filter((r) => r.kind === kind && r.privateRef === privateRef);
          return matches.length === 1 ? { id: matches[0]!.id } : undefined;
        },
      };
      if ((await active.store.read()).revision !== snapshot.revision) fail();
      await binding();
      credential(actor);
      observation.assertUnchanged();
      return { scope: structuredClone(proof.scope), decision: projectGuardDecision(projection, safe, now()) };
    },
    async readCaptureFacts(actor: MutationActor) {
      const active = await binding();
      const snapshot = await active.store.read();
      const observed = await facts(actor, snapshot.revision, active);
      if ((await active.store.read()).revision !== snapshot.revision) fail();
      await binding();
      same(currentFacts(actor, snapshot.revision, active), observed);
      return structuredClone(observed);
    },
    qualify: async (snapshot: TypedSidecarSnapshot, action: ActionEvidenceV1, signal: AbortSignal) =>
      leases.withOwnership(lease, async () => {
        signal.throwIfAborted();
        const active = await binding();
        // A current action needs an actual retained capture; its original exact credential
        // comes from that live registration, not a client-provided proof or saved token.
        const capture = await captures.forAction(structuredClone(action), active);
        const source = captures.snapshot(capture);
        if (source.binding !== active || lease.resource !== `run:${action.invocation.runId}`) return fail();
        same(source.action, action);
        if (action.workspaceRef.state !== "complete") fail();
        same(action.workspaceRef.value, source.resourceWorkspaceRef);
        const actor = structuredClone(source.actor);
        const target = structuredClone(source.target),
          resourceWorkspaceRef = source.resourceWorkspaceRef;
        const assertCapture = () => {
          const retained = captures.snapshot(capture);
          if (retained.binding !== active) fail();
          same(retained.action, action);
          same(retained.actor, actor);
          same(retained.target, target);
          same(retained.resourceWorkspaceRef, resourceWorkspaceRef);
          if (captures.assertCurrent(capture, action.authority) !== undefined) fail();
        };
        same(actor.principalId, action.invocation.principalRef);
        const observed = await facts(actor, snapshot.revision, active);
        same(factsOf(action), observed);
        verified(action);
        assertCapture();
        if (!snapshot.document.scopedRules.records.length) return fail();
        if (!execution.observe) return fail();
        const observation = await execution.observe(
          async () => {
            const proofs: Approval[] = [];
            for (const record of snapshot.document.scopedRules.records) {
              const proof = await readApproval(record);
              same(proof.binding, identity(active));
              credential(proof.actor);
              proofs.push(proof);
            }
            return proofs;
          },
          { maxRecords: 1024 },
        );
        const proofs = observation.value;
        if (!observation.assertUnchanged) return fail();
        const assertProofs = observation.assertUnchanged.bind(observation);
        await binding();
        same(await facts(actor, snapshot.revision, active), observed);
        assertCapture();
        signal.throwIfAborted();
        return {
          sourceRefs: proofs.flatMap((p) => p.reviewSourceRefs),
          scopeEvidenceRef: proofs[0]!.scopeEvidenceRef,
          approvalRecordRef: proofs[0]!.command.approvalRecordRef,
          authorityRevision: observed.authorityRevision,
          assertCurrent: (): undefined => {
            assertProofs();
            assertManagedTypedStoreBinding(active);
            same(currentFacts(actor, snapshot.revision, active), observed);
            for (const proof of proofs) credential(proof.actor);
            signal.throwIfAborted();
            assertCapture();
            return undefined;
          },
        };
      }),
  });
}
