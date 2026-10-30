/** Inactive #702 policy inputs projected from existing protected rules and authority, never an RPC or new store. */
import type { ActionEvidenceV1, ActionResourceV1, AuthorityStampV1, FactV1 } from "./tool-execution-guards.js";

export type StrictActionFact =
  | "rawDuplicateKeyValidation"
  | "effectiveCwd"
  | "workspaceRef"
  | "resources"
  | "executableAndInterpreter"
  | "stdin"
  | "environmentAndCredentialRefs"
  | "relevantStateRefs";

export interface StrictActionProfile {
  readonly profileRef: string;
  readonly minimumCoverage: "policy-per-ask" | "verified-per-execution";
  /** Every named fact must be complete unless explicitly allowed to be inapplicable. */
  readonly facts: Readonly<Record<StrictActionFact, "complete" | "complete-or-absent">>;
}

export interface StrictRuleDelegation {
  readonly requirement: "required" | "advisory";
  readonly projectionPolicyRevision: string;
  readonly destinationPolicyRef: string;
  readonly judgeConfigRef: string;
  readonly maximumDurationMs: number;
  readonly onNotFit: "deny" | "require-human";
  readonly onIndeterminate: "indeterminate" | "require-human";
  /** Only transport unavailability, and only an independently allowing advisory rule. */
  readonly allowWhenUnavailable: boolean;
}

/** Exact predicates only. No ACP title/kind/prefix heuristic is promoted to execution evidence. */
interface StrictPermissionRuleFields {
  readonly ruleId: string;
  readonly ruleRevision: string;
  readonly status: "approved" | "revoked";
  readonly notBefore: string;
  readonly match: {
    readonly principalRef: string;
    readonly agentId: string;
    readonly hostId: string;
    readonly runnerId: string;
    readonly operation: string;
    readonly profileRef: string;
    readonly coverageId: string;
    readonly effectiveCwd: string;
    readonly workspaceRef: string;
    readonly resources: readonly ActionResourceV1[];
    readonly environmentAndCredentialRefs: readonly string[];
  };
  readonly decision: "allow" | "deny" | "require-human";
  readonly delegation?: StrictRuleDelegation;
}

/** Legacy finite grants retain their original meaning. Version 2 is explicitly
 * until revoked; null is never accepted without that discriminator. Action and
 * permit expiries remain separate and always finite. */
export type StrictPermissionRule = StrictPermissionRuleFields &
  ({ readonly version?: never; readonly expiresAt: string } | { readonly version: 2; readonly expiresAt: null });

/** Owner supplies fresh verified state from existing authorities/config/sidecars on every phase. */
export interface StrictPermissionState {
  readonly authority: AuthorityStampV1;
  readonly currentAuthority: FactV1<boolean>;
  readonly capturedCeiling: FactV1<boolean>;
  readonly protectedAccess: FactV1<boolean>;
  /** Exact qualification/preconditions checked by the trusted capture owner, not model advice. */
  readonly coverageAndState: FactV1<boolean>;
  readonly mandatoryHuman: FactV1<boolean>;
  readonly profile: FactV1<StrictActionProfile>;
  /** Missing/unreadable required material must remain unknown/absent; never legacy empty fallback. */
  readonly rules: FactV1<readonly StrictPermissionRule[]>;
}

export interface StrictPermissionSource {
  /** Internal capability. Bind to existing original-principal/run authority, not caller replacements. */
  readCurrent(action: ActionEvidenceV1, signal: AbortSignal): Promise<StrictPermissionState>;
}
