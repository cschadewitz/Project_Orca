/** Owner-local reviewed commands. No production bootstrap constructs this test/integration seam. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { OrcaError, type ActionEvidenceV1, type MutationActor } from "@orca/core";
import {
  createInactiveTypedSidecarStore,
  type InactiveTypedSidecarOwner,
  type CreateScopedRule,
  type TypedSidecarSnapshot,
} from "@orca/agents";
import type { LiveHumanInput } from "@orca/engine";
import { LiveDecisionTargetSchema, OperatorTargetSchema, type LiveDecisionTarget } from "@orca/protocol";
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
}
export interface ScopedPermissionOwner {
  readonly sidecar: InactiveTypedSidecarOwner;
  readonly live: LiveHumanInput;
  readonly disclosure: GuardProjectionDisclosure;
  prepare(
    target: LiveDecisionTarget,
    actor: MutationActor,
    snapshot: TypedSidecarSnapshot,
  ): Promise<RetainedScopedReview>;
  /** Exact protected approval/action/scope lookup, synchronous and nonmutating at publication. */
  assertCurrent(review: RetainedScopedReview, actor: MutationActor): undefined;
  readAuthorityRevision(): Promise<string>;
  assertAuthorityRevision(revision: string): undefined;
}
const stale = (): never => {
  throw new OrcaError("CONFIG_STALE", "Scoped review is unavailable; review again.");
};
const targetSchema = z.strictObject({ target: OperatorTargetSchema, input: LiveDecisionTargetSchema.strict() });
const handleSchema = z.strictObject({ target: OperatorTargetSchema, handle: z.uuid() });

/** Requires real authentication and a validated typed-owner token; no client option enables registration. */
export function scopedPermissionMethods(
  owner: ScopedPermissionOwner,
  identity: { workspaceId: string; instanceId: string },
  authorizer: Authorizer,
): MethodTable {
  const policy = createInactiveTypedSidecarStore(owner.sidecar);
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
  const current = (entry: Entry) => {
    if (
      !Number.isFinite(entry.review.reviewUntil) ||
      Date.now() >= entry.review.reviewUntil ||
      owner.live.inspect(entry.input) !== "pending"
    )
      stale();
    if (owner.assertCurrent(structuredClone(entry.review), { ...entry.actor }) !== undefined) stale();
  };
  const lookup = (ctx: MethodContext, params: z.infer<typeof handleSchema>) => {
    const call = context(ctx, params.target);
    const entry = retained.get(params.handle);
    if (!entry || !isDeepStrictEqual(entry.actor, call.answer.actor)) stale();
    return { ...call, entry: entry! };
  };
  return {
    "scopedPermissions.review": {
      params: targetSchema,
      handle: async (params, ctx) => {
        const call = context(ctx, params.target);
        await call.answer.authorize(params.input, true);
        const snapshot = await policy.read();
        const review = structuredClone(
          await owner.prepare(structuredClone(params.input), { ...call.answer.actor }, snapshot),
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
        current(entry);
        await call.answer.authorize(entry.input, true);
        current(entry);
        const handle = randomUUID();
        retained.set(handle, entry);
        return {
          handle,
          reviewUntil: review.reviewUntil,
          decision: projectGuardDecision(review.projection, owner.disclosure, Date.now()),
        };
      },
    },
    "scopedPermissions.choose": {
      params: handleSchema.extend({ choice: z.enum(["save", "allow-once", "deny"]) }),
      handle: async (params, ctx) => {
        const { entry, principal, answer } = lookup(ctx, params);
        if (!(entry.state === "ready" || (entry.state === "saved" && params.choice !== "save"))) stale();
        current(entry);
        // Claim before any await; even a lost acknowledgement never permits automatic replay.
        entry.state = "pending";
        try {
          await answer.authorize(entry.input, params.choice === "save");
          current(entry);
          if (params.choice === "save") {
            const exact = (command: CreateScopedRule, actor: MutationActor) => {
              current(entry);
              if (!isDeepStrictEqual(command, entry.review.command) || !isDeepStrictEqual(actor, entry.actor)) stale();
            };
            const authority = authorizer.scopedRuleGrantAuthority(principal, {
              readAuthorityRevision: () => owner.readAuthorityRevision(),
              verifyApproval: async (command, actor) => {
                exact(command, actor);
                return { scopeEvidenceRef: entry.review.scopeEvidenceRef };
              },
              assertCommitCurrent: (command, actor, proof) => {
                exact(command, actor);
                if (
                  proof.scopeEvidenceRef !== entry.review.scopeEvidenceRef ||
                  owner.assertAuthorityRevision(proof.authorityRevision) !== undefined
                )
                  stale();
                return undefined;
              },
            });
            await policy.createScopedRule(entry.review.command, authority);
            entry.state = "saved";
          } else {
            const result = await owner.live.answer(
              {
                target: entry.input,
                optionId: params.choice === "deny" ? entry.review.denyOptionId : entry.review.onceOptionId,
              },
              answer,
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
        const snapshot = await policy.read();
        const record = snapshot.document.scopedRules.records.find(
          (r) =>
            isDeepStrictEqual(r.rule, entry.review.command.rule) &&
            r.approvalRecordRef === entry.review.command.approvalRecordRef &&
            isDeepStrictEqual(r.actor, entry.actor),
        );
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
}
