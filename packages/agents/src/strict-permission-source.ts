/** Inactive #702 read adapter. Owner capabilities only; no registration, cache or writer. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  PermissionPolicyFileSchema,
  PermissionPolicySchema,
  type ActionEvidenceV1,
  type FactV1,
  type StrictPermissionRule,
  type StrictPermissionSource,
  type StrictPermissionState,
} from "@orca/core";

export type StrictRuleRead =
  | { readonly state: "unavailable" | "malformed" | "unsupported"; readonly reason: string }
  | {
      readonly state: "qualified";
      readonly rules: readonly StrictPermissionRule[];
      /** Issued by the protected source owner, never supplied by an ACP request or model. */
      readonly provenance: {
        readonly sourceRefs: readonly string[];
        readonly policyRevision: string;
        readonly authorityRevision: string;
        /** Binds the exact ordered projection, including rule revisions and delegation. */
        readonly projectionDigest: string;
        readonly scopeEvidenceRef: string;
        readonly approvalRecordRef: string;
      };
    };

/** A content binding, not an authorization, public hash or persisted schema. */
export function strictRuleProjectionDigest(rules: readonly StrictPermissionRule[]): string {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex");
}

/** Exact in-memory projection encoding; not a choice of future on-disk schema. */
export function strictPermissionRuleRevision(rule: Omit<StrictPermissionRule, "ruleRevision">): string {
  const { ruleRevision: _revision, ...content } = rule as StrictPermissionRule;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * Inspect existing configured policy and sidecar bytes without the legacy missing-file
 * fallback or schema stripping promoting them into typed authority. Even an empty legacy
 * policy has a default/floor whose strict semantics have not been qualified.
 */
export async function readLegacyStrictRuleMaterial(options: {
  configured: unknown;
  files: readonly string[];
  read?: (file: string) => Promise<string>;
}): Promise<StrictRuleRead> {
  if (!strings(options.files)) return { state: "malformed", reason: "sidecar-source-list-invalid" };
  if (object(options.configured) && options.configured.rules !== undefined && !denseArray(options.configured.rules))
    return { state: "malformed", reason: "configured-policy-invalid" };
  if (!PermissionPolicySchema.safeParse(options.configured).success)
    return { state: "malformed", reason: "configured-policy-invalid" };
  for (const file of options.files) {
    let text: string;
    try {
      text = await (options.read ?? ((path) => readFile(path, "utf8")))(file);
    } catch {
      return { state: "unavailable", reason: "required-sidecar-unavailable" };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return { state: "malformed", reason: "sidecar-json-invalid" };
    }
    if (object(doc) && doc.version !== undefined && doc.version !== 1)
      return { state: "unsupported", reason: "sidecar-version-unsupported" };
    if (!PermissionPolicyFileSchema.safeParse(doc).success)
      return { state: "malformed", reason: "sidecar-policy-invalid" };
  }
  return { state: "unsupported", reason: "legacy-policy-has-no-qualified-typed-scope" };
}

type CurrentBoundary = Omit<StrictPermissionState, "rules" | "capturedCeiling">;

export interface StrictPermissionReadOptions {
  /** Captured once by the original run owner. Current reads cannot widen this ceiling. */
  readonly capturedCeiling: FactV1<boolean>;
  /** Original principal/run/lease and current protected config; not public request fields. */
  readBoundary(action: ActionEvidenceV1, signal: AbortSignal): Promise<CurrentBoundary>;
  /** Fresh ordered projection from the same protected authorities on every read. */
  readRules(action: ActionEvidenceV1, signal: AbortSignal): Promise<StrictRuleRead>;
}

export function createStrictPermissionSource(options: StrictPermissionReadOptions): StrictPermissionSource {
  const capturedCeiling = structuredClone(options.capturedCeiling);
  return {
    async readCurrent(action, signal) {
      const original = structuredClone(action);
      const before = structuredClone(await options.readBoundary(structuredClone(original), signal));
      let material: StrictRuleRead;
      try {
        material = structuredClone(await options.readRules(structuredClone(original), signal));
      } catch {
        material = { state: "unavailable", reason: "required-policy-unavailable" };
      }
      // Rules may have awaited IO. Recheck all current ceilings/epochs, not just a rule id.
      const current = structuredClone(await options.readBoundary(structuredClone(original), signal));
      let rules: StrictPermissionState["rules"];
      if (signal.aborted) rules = unknown("invocation-expired");
      else if (!isDeepStrictEqual(before, current)) rules = unknown("policy-source-changed-during-read");
      else {
        try {
          rules = projectRules(material, current);
        } catch {
          rules = unknown("strict-policy-malformed-material");
        }
      }
      return { ...current, capturedCeiling: structuredClone(capturedCeiling), rules };
    },
  };
}

function unknown(reason: string): FactV1<readonly StrictPermissionRule[]> {
  return { state: "unknown", reason };
}

function projectRules(material: StrictRuleRead, boundary: CurrentBoundary): StrictPermissionState["rules"] {
  if (material.state !== "qualified") return unknown(`strict-policy-${material.state}:${material.reason}`);
  const p = material.provenance;
  if (
    !p ||
    !denseArray(p.sourceRefs) ||
    !p.sourceRefs.length ||
    !p.sourceRefs.every(nonempty) ||
    !nonempty(p.scopeEvidenceRef) ||
    !nonempty(p.approvalRecordRef) ||
    !nonempty(p.policyRevision) ||
    !nonempty(p.authorityRevision) ||
    p.policyRevision !== boundary.authority.currentPolicyRevision ||
    p.authorityRevision !== boundary.authority.authorityRevision
  )
    return unknown("strict-policy-untrusted-provenance");
  if (!denseArray(material.rules) || !material.rules.every(validStrictPermissionRule))
    return unknown("strict-policy-malformed-typed-rules");
  if (new Set(material.rules.map((rule) => rule.ruleId)).size !== material.rules.length)
    return unknown("strict-policy-ambiguous-rule-identity");
  if (material.rules.some((rule) => rule.ruleRevision !== strictPermissionRuleRevision(rule)))
    return unknown("strict-policy-rule-revision-mismatch");
  if (p.projectionDigest !== strictRuleProjectionDigest(material.rules))
    return unknown("strict-policy-projection-revision-mismatch");
  return { state: "complete", value: structuredClone(material.rules) };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}
/** Array iteration methods skip holes; every admitted slot must be an own element. */
function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}
function strings(value: unknown): boolean {
  return denseArray(value) && value.every(nonempty);
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
export function validStrictPermissionRule(value: unknown): value is StrictPermissionRule {
  if (!object(value) || !object(value.match)) return false;
  if (
    !exact(
      value,
      ["ruleId", "ruleRevision", "status", "notBefore", "expiresAt", "match", "decision"],
      ["delegation", "version"],
    ) ||
    !nonempty(value.ruleId) ||
    !nonempty(value.ruleRevision) ||
    !oneOf(value.status, ["approved", "revoked"]) ||
    !oneOf(value.decision, ["allow", "deny", "require-human"]) ||
    typeof value.notBefore !== "string" ||
    !Number.isFinite(Date.parse(value.notBefore)) ||
    !(
      (Object.hasOwn(value, "version") && value.version === 2 && value.expiresAt === null) ||
      (!Object.hasOwn(value, "version") &&
        typeof value.expiresAt === "string" &&
        Number.isFinite(Date.parse(value.expiresAt)) &&
        Date.parse(value.notBefore) < Date.parse(value.expiresAt))
    )
  )
    return false;
  const m = value.match;
  const identity = [
    "principalRef",
    "agentId",
    "hostId",
    "runnerId",
    "operation",
    "profileRef",
    "coverageId",
    "effectiveCwd",
    "workspaceRef",
  ];
  if (
    !exact(m, [...identity, "resources", "environmentAndCredentialRefs"]) ||
    !identity.every((key) => nonempty(m[key])) ||
    !strings(m.environmentAndCredentialRefs) ||
    !denseArray(m.resources) ||
    !m.resources.every((resource: unknown) => {
      if (!object(resource)) return false;
      const keys =
        resource.targetKind === "disposable-memory"
          ? ["operation", "targetKind", "ownerRef", "resourceRef", "resourceRevision"]
          : ["operation", "physicalTargetRef"];
      return exact(resource, keys) && keys.every((key) => nonempty(resource[key]));
    })
  )
    return false;
  if (value.delegation === undefined) return true;
  const d = value.delegation;
  return (
    object(d) &&
    exact(d, [
      "requirement",
      "projectionPolicyRevision",
      "destinationPolicyRef",
      "judgeConfigRef",
      "maximumDurationMs",
      "onNotFit",
      "onIndeterminate",
      "allowWhenUnavailable",
    ]) &&
    oneOf(d.requirement, ["required", "advisory"]) &&
    oneOf(d.onNotFit, ["deny", "require-human"]) &&
    oneOf(d.onIndeterminate, ["indeterminate", "require-human"]) &&
    [d.projectionPolicyRevision, d.destinationPolicyRef, d.judgeConfigRef].every(nonempty) &&
    typeof d.maximumDurationMs === "number" &&
    Number.isFinite(d.maximumDurationMs) &&
    d.maximumDurationMs > 0 &&
    typeof d.allowWhenUnavailable === "boolean"
  );
}

/** Persistence implementation and command types live together; no runtime registration. */
export type { StrictScopedRuleWritePort } from "./typed-sidecar.js";
