/** Owner-local reviewed commands. No production bootstrap constructs this test/integration seam. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { OrcaError, type ActionEvidenceV1, type MutationActor } from "@orca/core";
import {
  assertManagedTypedStoreBinding,
  type ManagedTypedStoreProvider,
  type ManagedTypedStoreBinding,
  type CreateScopedRule,
  type TypedSidecarSnapshot,
} from "@orca/agents";
import type { LiveHumanInput } from "@orca/engine";
import { SCOPED_PERMISSION_CONTRACTS, ScopedPermissionScopeSchema, type LiveDecisionTarget } from "@orca/protocol";
import {
  projectGuardDecision,
  type GuardDecisionProjectionInput,
  type GuardProjectionDisclosure,
} from "../../protocol/src/guard-decision-projection.js";
import { authRequired } from "./auth/errors.js";
import { principalOf, type Authorizer } from "./auth/guard.js";
import type { MethodContext, MethodTable } from "./methods.js";

/** Private owner record; the renderer never imports it and public receipt JSON cannot recreate it. */
export interface RetainedScopedReview {
  readonly command: CreateScopedRule;
  readonly action: ActionEvidenceV1;
  readonly scopeEvidenceRef: string;
  readonly reviewUntil: number;
  readonly onceOptionId: string;
  readonly denyOptionId: string;
  readonly projection: GuardDecisionProjectionInput;
  /** Exact text approved by the trusted destination disclosure owner, never model output. */
  readonly scope: z.infer<typeof ScopedPermissionScopeSchema>;
  readonly requiredReview: "passed" | "failed" | "unavailable";
  readonly persistenceReview?: { readonly result: "passed"; readonly sourceRefs: readonly string[] };
  /** Capability availability only; a fresh protected standing approval is required inside Save. */
  readonly standingReviewAvailable?: boolean;
  /** Runtime owner record only: displayed-handle lifetime is not Save execution authority. */
  readonly pendingGrantIntent?: true;
}
export interface ScopedPermissionOwner {
  readonly currentStore: ManagedTypedStoreProvider;
  readonly live: LiveHumanInput;
  readonly disclosure: GuardProjectionDisclosure;
  prepare(
    target: LiveDecisionTarget,
    actor: MutationActor,
    snapshot: TypedSidecarSnapshot,
    binding: ManagedTypedStoreBinding,
  ): Promise<RetainedScopedReview>;
  /** Exact protected approval/action/scope lookup, synchronous and nonmutating at publication. */
  assertCurrent(review: RetainedScopedReview, actor: MutationActor): undefined;
  /** Original finite action only, including the live registry's accepting phase.
   * This cannot authorize Save or reuse a pending grant as execution authority. */
  assertAnswerCurrent?(review: RetainedScopedReview, actor: MutationActor): undefined;
  readAuthorityRevision(review: RetainedScopedReview, actor: MutationActor): Promise<string>;
  assertAuthorityRevision(review: RetainedScopedReview, actor: MutationActor, revision: string): undefined;
  /** Original run lease spans protected Save acceptance AND standing publication. */
  withSaveOwnership<T>(review: RetainedScopedReview, actor: MutationActor, work: () => Promise<T>): Promise<T>;
  /** Called only after actual explicit Save authorization; never on review/inspect. */
  recordApproval(review: RetainedScopedReview, actor: MutationActor): Promise<void>;
  verifyApproval(review: RetainedScopedReview, actor: MutationActor): Promise<{ readonly scopeEvidenceRef: string }>;
  /** Confirmed policy change invalidates old decision attempts; no dispatch/retry. */
  policySaved(review: RetainedScopedReview, actor: MutationActor): Promise<void>;
}
const stale = (): never => {
  throw new OrcaError("CONFIG_STALE", "Scoped review is unavailable; review again.");
};
const contracts = SCOPED_PERMISSION_CONTRACTS;
const targetSchema = contracts["scopedPermissions.review"].params;
const handleSchema = contracts["scopedPermissions.inspect"].params;

/** Requires real authentication and a validated typed-owner token; no client option enables registration. */
export function scopedPermissionMethods(
  owner: ScopedPermissionOwner,
  identity: { workspaceId: string; instanceId: string },
  authorizer: Authorizer,
): MethodTable {
  const provider = owner.currentStore;
  let binding: ManagedTypedStoreBinding | undefined;
  const currentStore = async () => {
    const available = await provider();
    if (!available.available || available.contract !== "orca-typed-sidecar-v1") return stale();
    const candidate = available.binding;
    assertManagedTypedStoreBinding(candidate);
    if (candidate.store !== available.store || (binding && candidate !== binding)) stale();
    binding ??= candidate;
    return candidate.store;
  };
  type Entry = {
    review: RetainedScopedReview;
    actor: MutationActor;
    input: LiveDecisionTarget;
    state: "ready" | "pending" | "saved" | "refused" | "uncertain" | "answered" | "cancelled";
  };
  const retained = new Map<string, Entry>();
  const context = (ctx: MethodContext, target: typeof identity) => {
    const bound = principalOf(ctx);
    if (!bound || !bound.principal.credentialId || !ctx.liveAnswerAuthority) throw authRequired();
    if (!isDeepStrictEqual(target, identity)) stale();
    return { principal: bound.principal, answer: ctx.liveAnswerAuthority };
  };
  const current = (entry: Entry, accepting = false) => {
    if (!binding) return stale();
    assertManagedTypedStoreBinding(binding);
    if (
      !Number.isFinite(entry.review.reviewUntil) ||
      (Date.now() >= entry.review.reviewUntil && !(entry.state === "pending" && entry.review.pendingGrantIntent)) ||
      !(owner.live.inspect(entry.input) === "pending" || (accepting && owner.live.inspect(entry.input) === "accepting"))
    )
      stale();
    const result =
      accepting && owner.assertAnswerCurrent
        ? owner.assertAnswerCurrent(structuredClone(entry.review), { ...entry.actor })
        : owner.assertCurrent(structuredClone(entry.review), { ...entry.actor });
    if (result !== undefined) stale();
  };
  const lookup = (ctx: MethodContext, params: z.infer<typeof handleSchema>) => {
    const call = context(ctx, params.target);
    const entry = retained.get(params.handle);
    if (!entry || !isDeepStrictEqual(entry.actor, call.answer.actor)) stale();
    return { ...call, entry: entry! };
  };
  const table: MethodTable = {
    "scopedPermissions.review": {
      params: targetSchema,
      handle: async (params, ctx) => {
        const call = context(ctx, params.target);
        await call.answer.authorize(params.input, true);
        const policy = await currentStore();
        const snapshot = await policy.read();
        const review = structuredClone(
          await owner.prepare(structuredClone(params.input), { ...call.answer.actor }, snapshot, binding!),
        );
        const entry: Entry = {
          review,
          actor: { ...call.answer.actor },
          input: structuredClone(params.input),
          state: "ready",
        };
        if (review.command.expectedRevision !== snapshot.revision) stale();
        for (const key of ["instanceId", "sessionId", "turnId", "invocationId", "runId", "stepRunId"] as const)
          if (review.action.invocation[key] !== entry.input[key]) stale();
        await currentStore();
        current(entry);
        await call.answer.authorize(entry.input, true);
        current(entry);
        for (const [key, value] of retained)
          if (value.review.reviewUntil <= Date.now() && value.state !== "pending") retained.delete(key);
        if (retained.size >= 1024) stale();
        const handle = randomUUID();
        retained.set(handle, entry);
        return {
          handle,
          reviewUntil: review.reviewUntil,
          scope: ScopedPermissionScopeSchema.parse(review.scope),
          requiredReview: review.requiredReview,
          standingReview:
            review.command.rule.version === 2
              ? review.standingReviewAvailable
                ? "available"
                : "unavailable"
              : "available",
          // Describes retained prerequisites only. The actual Save path below
          // still acquires current authority and a fresh protected standing review.
          // Keep a failed execution review conservatively blocked in presentation.
          saveEligibility:
            review.requiredReview !== "failed" &&
            (review.requiredReview === "passed" || review.persistenceReview?.result === "passed") &&
            (review.command.rule.version !== 2 || review.standingReviewAvailable === true) &&
            review.action.coverage.level === "verified-per-execution"
              ? "eligible"
              : "unavailable",
          decision: projectGuardDecision(review.projection, owner.disclosure, Date.now()),
        };
      },
    },
    "scopedPermissions.choose": {
      params: contracts["scopedPermissions.choose"].params,
      handle: async (params, ctx) => {
        const { entry, principal, answer } = lookup(ctx, params);
        if (entry.state !== "ready") stale();
        current(entry);
        // No standing approval was issued, so no write can have started. Leave
        // this live handle available for an explicit ordinary answer.
        if (
          params.choice === "save" &&
          entry.review.command.rule.version === 2 &&
          !entry.review.standingReviewAvailable
        )
          stale();
        // Claim before any await; even a lost acknowledgement never permits automatic replay.
        entry.state = "pending";
        try {
          const policy = await currentStore();
          await answer.authorize(entry.input, params.choice === "save");
          await currentStore();
          current(entry);
          if (params.choice === "save") {
            if (
              (entry.review.requiredReview !== "passed" && entry.review.persistenceReview?.result !== "passed") ||
              (entry.review.command.rule.version === 2 && !entry.review.standingReviewAvailable) ||
              entry.review.action.coverage.level !== "verified-per-execution"
            )
              stale();
            const exact = (command: CreateScopedRule, actor: MutationActor) => {
              current(entry);
              if (!isDeepStrictEqual(command, entry.review.command) || !isDeepStrictEqual(actor, entry.actor)) stale();
            };
            const authority = authorizer.scopedRuleGrantAuthority(principal, {
              readAuthorityRevision: async () => {
                await currentStore();
                return owner.readAuthorityRevision(entry.review, entry.actor);
              },
              verifyApproval: async (command, actor) => {
                await currentStore();
                exact(command, actor);
                return owner.verifyApproval(entry.review, entry.actor);
              },
              assertCommitCurrent: (command, actor, proof) => {
                exact(command, actor);
                if (
                  proof.scopeEvidenceRef !== entry.review.scopeEvidenceRef ||
                  owner.assertAuthorityRevision(entry.review, entry.actor, proof.authorityRevision) !== undefined
                )
                  stale();
                return undefined;
              },
            });
            await owner.withSaveOwnership(entry.review, entry.actor, async () => {
              await authority.authorizeGrant();
              current(entry);
              await owner.recordApproval(entry.review, entry.actor);
              current(entry);
              await policy.createScopedRule(entry.review.command, authority);
            });
            await currentStore();
            await owner.policySaved(entry.review, entry.actor);
            entry.state = "saved";
          } else {
            const result = await owner.live.answer(
              {
                target: entry.input,
                optionId: params.choice === "deny" ? entry.review.denyOptionId : entry.review.onceOptionId,
              },
              {
                actor: answer.actor,
                authorize: async (target, standing) => {
                  await answer.authorize(target, standing);
                  current(entry, true);
                },
              },
            );
            entry.state = result.delivered ? "answered" : "uncertain";
          }
        } catch {
          // A writer or append can have committed before throwing. Never return raw private errors.
          entry.state = "uncertain";
        }
        return { outcome: entry.state };
      },
    },
    "scopedPermissions.inspect": {
      params: handleSchema,
      handle: async (params, ctx) => {
        const { entry, answer } = lookup(ctx, params);
        await answer.authorize(entry.input, true);
        const policy = await currentStore();
        const snapshot = await policy.read();
        const record = snapshot.document.scopedRules.records.find(
          (r) =>
            isDeepStrictEqual(r.rule, entry.review.command.rule) &&
            r.approvalRecordRef === entry.review.command.approvalRecordRef &&
            r.scopeEvidenceRef === entry.review.scopeEvidenceRef &&
            isDeepStrictEqual(r.actor, entry.actor),
        );
        await answer.authorize(entry.input, true);
        return { outcome: entry.state, retainedRule: Boolean(record) };
      },
    },
    "scopedPermissions.cancel": {
      params: handleSchema,
      handle: (params, ctx) => {
        const { entry } = lookup(ctx, params);
        if (entry.state === "pending") stale();
        entry.state = "cancelled";
        return { outcome: "cancelled" };
      },
    },
  };
  return Object.fromEntries(
    Object.entries(table).map(([name, method]) => [
      name,
      {
        params: method.params,
        handle: async (params: unknown, ctx: MethodContext) => {
          try {
            const result = await method.handle(params, ctx);
            if (binding) await currentStore();
            return result;
          } catch {
            throw new OrcaError(
              "CONFIG_STALE",
              "Scoped review unavailable; inspect current state before another attempt.",
            );
          }
        },
      },
    ]),
  );
}
