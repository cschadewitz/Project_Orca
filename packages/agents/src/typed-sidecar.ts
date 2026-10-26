/** Inactive #702 typed persistence. Trusted construction only; no RPC, migration or production caller. */
import { createHash } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  MutationActorSchema,
  OrcaError,
  PermissionPolicyFileSchema,
  type ActionEvidenceV1,
  type MutationActor,
  type PermissionPolicyFile,
  type StrictPermissionRule,
} from "@orca/core";
import { withPolicyLock } from "./permission-file.js";
import {
  strictPermissionRuleRevision,
  strictRuleProjectionDigest,
  validStrictPermissionRule,
  type StrictRuleRead,
} from "./strict-permission-source.js";

export interface TypedRuleRecord {
  readonly rule: StrictPermissionRule;
  readonly approvalRecordRef: string;
  readonly scopeEvidenceRef: string;
  readonly actor: MutationActor;
  readonly authorityRevision: string;
}
export interface TypedSidecar {
  readonly version: 2;
  readonly agents: PermissionPolicyFile["agents"];
  readonly scopedRules: { readonly version: 1; readonly records: readonly TypedRuleRecord[] };
}
export interface TypedSidecarSnapshot {
  readonly document: TypedSidecar;
  readonly revision: string;
}
export interface CreateScopedRule {
  readonly rule: StrictPermissionRule;
  readonly expectedRevision: string;
  readonly approvalRecordRef: string;
}
export interface RevokeScopedRule {
  readonly ruleId: string;
  readonly ruleRevision: string;
  readonly expectedRevision: string;
  readonly approvalRecordRef: string;
}
export interface ScopedRuleReceipt extends TypedRuleRecord {
  readonly outcome: "saved";
  readonly previousRevision: string;
  readonly revision: string;
}
/** Protected managed owner persists this outside rollbackable roots before fresh initialization. */
export interface TypedCompatibilityMarker {
  readonly version: 1;
  readonly workspaceRef: string;
  readonly sidecarRef: string;
  readonly format: "orca-permissions-v2";
  readonly minimumWriterContract: "orca-typed-sidecar-v1";
  readonly rootBindingRef: string;
  readonly enrollmentRef: string;
  readonly state: "enrollment-pending" | "enrolled";
}
export interface ScopedRuleGrantAuthority {
  readonly actor: MutationActor;
  /** Bound to the ORIGINAL credential, captured ceiling and current permissions.grant. */
  authorizeGrant(this: void): Promise<string>;
  /** Fresh synchronous/nonmutating exact review + authority observation. Never a Promise.
   * Cross-process credential/publication serialization requires integrated ownership. */
  assertCommitCurrent(
    this: void,
    command: CreateScopedRule,
    actor: MutationActor,
    proof: { readonly authorityRevision: string; readonly scopeEvidenceRef: string },
  ): undefined;
  /** Protected review lookup binds exact rule, actor and approval; never trust a public reference. */
  verifyApproval(
    this: void,
    command: CreateScopedRule,
    actor: MutationActor,
  ): Promise<{ readonly scopeEvidenceRef: string }>;
}
export interface StrictScopedRuleWritePort {
  createScopedRule(command: CreateScopedRule, authority: ScopedRuleGrantAuthority): Promise<ScopedRuleReceipt>;
}
export interface TypedSidecarOwnerPorts {
  readonly file: string;
  /** Trusted test/owner bound, never an RPC option. No stale/steal knob. */
  readonly lockTimeoutMs?: number;
  readonly marker: TypedCompatibilityMarker;
  /** Must observe exclusive generation, durable marker and all managed launch/recovery fences. */
  checkCompatibility(this: void): Promise<TypedCompatibilityMarker>;
  /** Synchronous/nonmutating retained lifetime/enrollment assertion, not cached disk parsing. */
  assertCompatibilityCurrent(this: void, marker: TypedCompatibilityMarker): undefined;
  /** Verify ALL protected approval/scope records against this action and fresh current authority. */
  qualify(
    this: void,
    snapshot: TypedSidecarSnapshot,
    action: ActionEvidenceV1,
    signal: AbortSignal,
  ): Promise<{
    readonly sourceRefs: readonly string[];
    readonly scopeEvidenceRef: string;
    readonly approvalRecordRef: string;
    readonly authorityRevision: string;
    /** Original owner checks retained proof/capture/current facts after the store's final awaits. */
    assertCurrent(this: void): undefined;
  }>;
}

// JSON, a structural cast or another owner's receipt cannot manufacture this capability.
const owners = new WeakMap<object, TypedSidecarOwnerPorts>();
const stores = new WeakMap<object, InactiveTypedSidecarStore>();
declare const ownerBrand: unique symbol;
export type InactiveTypedSidecarOwner = { readonly [ownerBrand]: true };
/** Trusted injection seam ONLY. No normal bootstrap/UI/flag constructs an owner. Activation is incomplete. */
export function bindInactiveTypedSidecarOwner(ports: TypedSidecarOwnerPorts): InactiveTypedSidecarOwner {
  const marker = structuredClone(ports.marker);
  if (!validMarker(marker)) invalid("invalid compatibility marker");
  const token = Object.freeze({}) as InactiveTypedSidecarOwner;
  owners.set(token, Object.freeze({ ...ports, marker }));
  return token;
}

/** Internal provider facts from the exact original capability, never parsed-marker reconstruction. */
export function retainedTypedSidecarOwner(owner: InactiveTypedSidecarOwner) {
  const ports = owners.get(owner);
  if (!ports) throw new OrcaError("NOT_SUPPORTED", "typed persistence requires its trusted owner");
  const { marker, assertCompatibilityCurrent, checkCompatibility } = ports;
  return Object.freeze({
    marker: Object.freeze(structuredClone(marker)),
    checkCurrent: async () => {
      const current = structuredClone(await checkCompatibility());
      if (!validMarker(current) || !isDeepStrictEqual(current, marker)) invalid("original owner changed");
      if (assertCompatibilityCurrent(structuredClone(marker)) !== undefined) invalid("synchronous owner required");
    },
    assertCurrent: (): undefined => {
      if (assertCompatibilityCurrent(structuredClone(marker)) !== undefined) invalid("synchronous owner required");
      return undefined;
    },
  });
}

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function exact(v: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return (
    required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => [...required, ...optional].includes(k))
  );
}
function dense(v: unknown): v is unknown[] {
  return Array.isArray(v) && Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean);
}
function invalid(reason: string): never {
  throw new OrcaError("CONFIG_INVALID", `typed permission state: ${reason}`);
}
function validMarker(v: unknown): v is TypedCompatibilityMarker {
  return (
    object(v) &&
    exact(v, [
      "version",
      "workspaceRef",
      "rootBindingRef",
      "sidecarRef",
      "format",
      "minimumWriterContract",
      "enrollmentRef",
      "state",
    ]) &&
    v.version === 1 &&
    v.format === "orca-permissions-v2" &&
    v.minimumWriterContract === "orca-typed-sidecar-v1" &&
    (v.state === "enrolled" || v.state === "enrollment-pending") &&
    [v.workspaceRef, v.rootBindingRef, v.sidecarRef, v.enrollmentRef].every(nonempty)
  );
}
function validActor(v: unknown): v is MutationActor {
  return (
    object(v) &&
    exact(v, ["principalId"], ["credentialId"]) &&
    nonempty(v.principalId) &&
    (!Object.hasOwn(v, "credentialId") || nonempty(v.credentialId)) &&
    MutationActorSchema.safeParse(v).success
  );
}
function validRecord(v: unknown): v is TypedRuleRecord {
  return (
    object(v) &&
    exact(v, ["rule", "approvalRecordRef", "scopeEvidenceRef", "actor", "authorityRevision"]) &&
    validStrictPermissionRule(v.rule) &&
    v.rule.ruleRevision === strictPermissionRuleRevision(v.rule) &&
    [v.approvalRecordRef, v.scopeEvidenceRef, v.authorityRevision].every(nonempty) &&
    validActor(v.actor)
  );
}
/** Exact v2 validation: never schema-strip future material or fill omitted typed/legacy predicates. */
export function parseTypedSidecar(raw: unknown): TypedSidecar {
  if (!object(raw) || !exact(raw, ["version", "agents", "scopedRules"]) || raw.version !== 2 || !object(raw.agents))
    invalid("unsupported or malformed envelope");
  const legacy = { version: 1, agents: raw.agents };
  const parsed = PermissionPolicyFileSchema.safeParse(legacy);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, legacy)) invalid("unknown or incomplete legacy material");
  const scoped = raw.scopedRules;
  if (
    !object(scoped) ||
    !exact(scoped, ["version", "records"]) ||
    scoped.version !== 1 ||
    !dense(scoped.records) ||
    !scoped.records.every(validRecord)
  )
    invalid("unsupported or malformed scoped records");
  if (new Set(scoped.records.map((r) => r.rule.ruleId)).size !== scoped.records.length)
    invalid("duplicate rule identity");
  return structuredClone(raw) as unknown as TypedSidecar;
}
/** JSON.parse normally discards earlier duplicate names, including escaped aliases. */
function refuseDuplicateKeys(bytes: string): void {
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (const [token] of bytes.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]/g)) {
    const frame = stack.at(-1);
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && frame) frame.key = true;
    else if (token === ":" && frame) frame.key = false;
    else if (token.startsWith('"') && frame?.key) {
      const name = JSON.parse(token) as string;
      if (frame.keys.has(name)) invalid("duplicate JSON key");
      frame.keys.add(name);
      frame.key = false;
    }
  }
}

/** Structural bytes only: no authority capability, legacy classification or filesystem lookup. */
export function parseTypedCompatibilityMarkerBytes(bytes: Uint8Array): TypedCompatibilityMarker {
  const raw = decodeStrictJson(bytes);
  if (!validMarker(raw)) invalid("unsupported or malformed compatibility marker");
  return structuredClone(raw);
}
function decodeStrictJson(input: Uint8Array): unknown {
  if (!(input instanceof Uint8Array)) invalid("JSON input must be bytes");
  const bytes = Buffer.from(input);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) invalid("invalid UTF-8");
  try {
    const raw: unknown = JSON.parse(text);
    refuseDuplicateKeys(text);
    return raw;
  } catch {
    invalid("invalid JSON");
  }
}
/** Required file; absence, empty, corrupt and unsupported data all refuse without a legacy fallback. */
export async function readTypedSidecar(file: string): Promise<TypedSidecarSnapshot> {
  const bytes = await readFile(file);
  return { document: parseTypedSidecar(decodeStrictJson(bytes)), revision: hash(bytes) };
}

function validateCreate(v: CreateScopedRule): void {
  if (
    !object(v) ||
    !exact(v, ["rule", "expectedRevision", "approvalRecordRef"]) ||
    !validStrictPermissionRule(v.rule) ||
    v.rule.ruleRevision !== strictPermissionRuleRevision(v.rule) ||
    v.rule.status !== "approved" ||
    v.rule.decision !== "allow" ||
    !nonempty(v.approvalRecordRef) ||
    !/^[a-f0-9]{64}$/.test(v.expectedRevision)
  )
    invalid("invalid create command");
}

/** No mode flag: only an identity-bound trusted owner capability reaches these inactive methods. */
export function createInactiveTypedSidecarStore(owner: InactiveTypedSidecarOwner): InactiveTypedSidecarStore {
  const ports = owners.get(owner);
  if (!ports) throw new OrcaError("NOT_SUPPORTED", "typed persistence requires its trusted owner");
  const existing = stores.get(owner);
  if (existing) return existing;
  const { file, marker, checkCompatibility, assertCompatibilityCurrent, qualify } = ports;
  if (typeof assertCompatibilityCurrent !== "function") invalid("synchronous compatibility assertion required");
  const lock = { strictOwnership: true, timeoutMs: ports.lockTimeoutMs ?? 10_000 };
  if (!Number.isFinite(lock.timeoutMs) || lock.timeoutMs <= 0 || lock.timeoutMs > 10_000)
    invalid("invalid lock timeout");
  async function check(phase: "initialize" | "access" = "access") {
    if (marker.state !== (phase === "initialize" ? "enrollment-pending" : "enrolled"))
      throw new OrcaError("NOT_SUPPORTED", "typed enrollment phase does not permit this operation");
    const current = structuredClone(await checkCompatibility());
    if (!validMarker(current) || !isDeepStrictEqual(current, marker))
      throw new OrcaError("NOT_SUPPORTED", "typed managed compatibility ownership unavailable");
  }
  function assertOwnerCurrent(): undefined {
    if (assertCompatibilityCurrent(structuredClone(marker)) !== undefined)
      invalid("compatibility assertion must be synchronous");
    return undefined;
  }
  async function noPendingWriter() {
    try {
      await lstat(`${file}.lock`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    throw new OrcaError("STORE_LOCK_TIMEOUT", "typed policy transition pending or owner unavailable");
  }
  async function read() {
    await check();
    await noPendingWriter();
    const snapshot = await readTypedSidecar(file);
    await check();
    await noPendingWriter();
    assertOwnerCurrent();
    return snapshot;
  }
  async function publish(document: TypedSidecar, authorize: () => Promise<void>, beforeDispatch: () => undefined) {
    const bytes = `${JSON.stringify(parseTypedSidecar(document), null, 2)}\n`;
    const revision = hash(bytes);
    const tmp = `${file}.${process.pid}.tmp`;
    let attempted = false;
    let prepared = false;
    try {
      // Private before the first policy byte, independent of the caller's umask.
      // Refuse existing temporary evidence instead of reusing its access mode.
      await writeFile(tmp, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
      prepared = true;
      await authorize();
      // There are NO awaits between these trusted current-state assertions and dispatch.
      // A revocation after dispatch cannot recall an irreversible filesystem operation.
      if (beforeDispatch() !== undefined) invalid("commit assertion must be synchronous");
      attempted = true;
      await rename(tmp, file);
    } catch (error) {
      if (attempted)
        throw new OrcaError(
          "INTERNAL",
          "typed permission publication uncertain; inspect without replay",
          {
            publication: "uncertain",
            intendedRevision: revision,
          },
          { cause: error },
        );
      throw error;
    } finally {
      // Cleanup failure must not mask an uncertain publication or invite replay.
      if (prepared) await rm(tmp, { force: true }).catch(() => undefined);
    }
    return revision;
  }
  async function change(
    command: CreateScopedRule | RevokeScopedRule,
    authority: ScopedRuleGrantAuthority,
    revoke: boolean,
  ): Promise<ScopedRuleReceipt> {
    // Do not let caller mutation replace the rule, approval, original actor or authorization functions across awaits.
    const input = structuredClone(command);
    const actor = structuredClone(authority.actor);
    const authorizeGrant = authority.authorizeGrant;
    const verifyApproval = authority.verifyApproval;
    const assertCommitCurrent = authority.assertCommitCurrent;
    if (typeof assertCommitCurrent !== "function") invalid("synchronous grant assertion required");
    if (!validActor(actor)) invalid("invalid grant actor");
    if (!revoke) validateCreate(input as CreateScopedRule);
    else if (
      !object(input) ||
      !exact(input, ["ruleId", "ruleRevision", "expectedRevision", "approvalRecordRef"]) ||
      ![input.ruleId, input.ruleRevision, input.approvalRecordRef].every(nonempty) ||
      !/^[a-f0-9]{64}$/.test(input.expectedRevision)
    )
      invalid("invalid revoke command");
    return withPolicyLock(file, lock, async (checkOwnership) => {
      await check();
      const initialAuthority = await authorizeGrant();
      if (!nonempty(initialAuthority)) invalid("missing grant authority revision");
      const snapshot = await readTypedSidecar(file);
      if (snapshot.revision !== input.expectedRevision)
        throw new OrcaError("CONFIG_STALE", "typed sidecar revision changed");
      const records = [...snapshot.document.scopedRules.records];
      let rule: StrictPermissionRule;
      if (revoke) {
        const target = input as RevokeScopedRule;
        const previous = records.find((r) => r.rule.ruleId === target.ruleId);
        if (!previous || previous.rule.ruleRevision !== target.ruleRevision || previous.rule.status !== "approved")
          throw new OrcaError("CONFIG_STALE", "typed rule revision changed or already revoked");
        const content = { ...previous.rule, status: "revoked" as const };
        rule = { ...content, ruleRevision: strictPermissionRuleRevision(content) };
      } else {
        rule = (input as CreateScopedRule).rule;
        // A used identity is never recycled, including an expired/revoked rule or a lost receipt.
        if (records.some((r) => r.rule.ruleId === rule.ruleId)) invalid("rule identity already used");
      }
      const reviewed = structuredClone(
        await verifyApproval(
          {
            rule: structuredClone(rule),
            expectedRevision: input.expectedRevision,
            approvalRecordRef: input.approvalRecordRef,
          },
          structuredClone(actor),
        ),
      );
      if (!object(reviewed) || !exact(reviewed, ["scopeEvidenceRef"]) || !nonempty(reviewed.scopeEvidenceRef))
        invalid("invalid protected approval");
      const record: TypedRuleRecord = {
        rule,
        actor,
        approvalRecordRef: input.approvalRecordRef,
        scopeEvidenceRef: reviewed.scopeEvidenceRef,
        authorityRevision: initialAuthority,
      };
      const next = revoke ? records.map((r) => (r.rule.ruleId === rule.ruleId ? record : r)) : [...records, record];
      const reviewedCommand = {
        rule: structuredClone(rule),
        expectedRevision: input.expectedRevision,
        approvalRecordRef: input.approvalRecordRef,
      };
      const revision = await publish(
        { ...snapshot.document, scopedRules: { version: 1, records: next } },
        async () => {
          // Complete filesystem IO before the last asynchronous trusted-state checks.
          await checkOwnership();
          if ((await readTypedSidecar(file)).revision !== snapshot.revision)
            throw new OrcaError("CONFIG_STALE", "typed sidecar changed before publication");
          const currentReview = await verifyApproval(structuredClone(reviewedCommand), structuredClone(actor));
          if (!isDeepStrictEqual(currentReview, reviewed)) invalid("protected approval changed during write");
          await check();
          if ((await authorizeGrant()) !== initialAuthority)
            throw new OrcaError("CONFIG_STALE", "grant authority changed during write");
        },
        () => {
          assertOwnerCurrent();
          if (
            assertCommitCurrent(structuredClone(reviewedCommand), structuredClone(actor), {
              authorityRevision: initialAuthority,
              scopeEvidenceRef: reviewed.scopeEvidenceRef,
            }) !== undefined
          )
            invalid("grant assertion must be synchronous");
          return undefined;
        },
      );
      return structuredClone({ outcome: "saved", ...record, previousRevision: snapshot.revision, revision });
    });
  }
  const store = Object.freeze({
    read,
    /** Fresh absent file ONLY. Protected marker is already durable. No existing file is converted or repaired. */
    async initializeFresh(): Promise<TypedSidecarSnapshot> {
      return withPolicyLock(file, lock, async (checkOwnership) => {
        await check("initialize");
        try {
          await readFile(file);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          const document: TypedSidecar = { version: 2, agents: {}, scopedRules: { version: 1, records: [] } };
          const revision = await publish(
            document,
            async () => {
              await checkOwnership();
              await check("initialize");
            },
            assertOwnerCurrent,
          );
          return { document, revision };
        }
        invalid("fresh opt-in requires absent sidecar");
      });
    },
    createScopedRule(command: CreateScopedRule, authority: ScopedRuleGrantAuthority) {
      return change(command, authority, false);
    },
    revokeScopedRule(command: RevokeScopedRule, authority: ScopedRuleGrantAuthority) {
      return change(command, authority, true);
    },
    async readRules(action: ActionEvidenceV1, signal: AbortSignal): Promise<StrictRuleRead> {
      const original = structuredClone(action);
      try {
        const snapshot = await read();
        const qualification = await qualify(structuredClone(snapshot), original, signal);
        const { assertCurrent, ...material } = qualification;
        const provenance = structuredClone(material);
        await check();
        if (signal.aborted) return { state: "unavailable", reason: "invocation-expired" };
        // Avoid qualification racing a revoke/save, including a same-process source used after restart.
        if ((await read()).revision !== snapshot.revision)
          return { state: "unavailable", reason: "typed-sidecar-changed-during-qualification" };
        if (typeof assertCurrent !== "function" || assertCurrent() !== undefined)
          invalid("current qualification required");
        const rules = snapshot.document.scopedRules.records.map((r) => r.rule);
        return {
          state: "qualified",
          rules,
          provenance: {
            ...provenance,
            policyRevision: snapshot.revision,
            projectionDigest: strictRuleProjectionDigest(rules),
          },
        };
      } catch {
        return { state: "unavailable", reason: "required-typed-state-or-authority-unavailable" };
      }
    },
  });
  stores.set(owner, store);
  return store;
}

export interface InactiveTypedSidecarStore {
  read(this: void): Promise<TypedSidecarSnapshot>;
  initializeFresh(this: void): Promise<TypedSidecarSnapshot>;
  createScopedRule(
    this: void,
    command: CreateScopedRule,
    authority: ScopedRuleGrantAuthority,
  ): Promise<ScopedRuleReceipt>;
  revokeScopedRule(
    this: void,
    command: RevokeScopedRule,
    authority: ScopedRuleGrantAuthority,
  ): Promise<ScopedRuleReceipt>;
  readRules(this: void, action: ActionEvidenceV1, signal: AbortSignal): Promise<StrictRuleRead>;
}
