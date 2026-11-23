/**
 * Inactive #701 connection preparation for the injected-endpoint ReviewJudge (#746). It is the seam between that
 * unchanged adapter and the authorized disclosure-grant (#363) and credential-reference (#335–#337) services, which do
 * not exist yet: their contracts below are PROPOSED, and only in-test fakes implement them. It produces the
 * manifest, limits and transport an owner would pass to `createEndpointReviewJudge`. It resolves no secret itself,
 * stores none, is registered nowhere and is absent from the agents barrel.
 */
import { createHash } from "node:crypto";
import { LOCAL_ADVICE_SCHEMA, LOCAL_EVIDENCE_SCHEMA } from "./adapter.js";
import {
  ENDPOINT_REQUEST_SCHEMA,
  endpointJudgeConfigRef,
  type EndpointJudgeLimits,
  type EndpointJudgeManifest,
  type EndpointJudgeTransport,
} from "./endpoint.js";

export const JUDGE_CONNECTION_SCHEMA = "orca-701-judge-connection/v0";
export const JUDGE_DISCLOSURE_PURPOSE = "review-judge";

/** Every field the #746 adapter puts in a request frame, in order. A grant must permit all of them. */
export const ENDPOINT_FRAME_FIELDS = ["schema", "requestId", "model", "prompt", "evidenceSchema", "evidence"] as const;

/** What a sender must declare it honors. A declaration is the owner's claim about injected code, not proof. */
export const REQUIRED_SENDER_CAPABILITIES = ["abort-signal", "response-byte-bound", "no-redirect", "no-retry"] as const;

/** PROPOSED (#336): an opaque reference. It carries no secret material and is not proof of authorization. */
export interface OpaqueCredentialRef {
  readonly kind: "credential-ref/v0";
  readonly id: string;
}

/** PROPOSED (#363): the exact destination and method a disclosure grant is asked for. */
export interface JudgeDisclosureQuery {
  readonly purpose: typeof JUDGE_DISCLOSURE_PURPOSE;
  readonly destination: string;
  readonly destinationPolicyRef: string;
  readonly projectionPolicyRevision: string;
  readonly methodVersion: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly evidenceSchema: typeof LOCAL_EVIDENCE_SCHEMA;
}

/** PROPOSED (#363): an approved grant echoes its query, lists the frame fields it lets leave and expires. */
export interface JudgeDisclosureGrant extends JudgeDisclosureQuery {
  readonly grantRef: string;
  readonly revision: string;
  readonly fields: readonly string[];
  readonly expiresAt: string;
}

/** PROPOSED (#363): lookup only. It can neither create nor widen a grant, and null means no approved grant. */
export interface JudgeDisclosureGrantService {
  readonly find: (query: JudgeDisclosureQuery, signal: AbortSignal) => Promise<JudgeDisclosureGrant | null>;
  /** The grant's current state, rechecked before every send; null once it is revoked or unknown. */
  readonly current: (
    grantRef: string,
    signal: AbortSignal,
  ) => Promise<{ readonly revision: string; readonly expiresAt: string } | null>;
}

/** PROPOSED (#336): metadata about a reference. Never secret material. */
export interface JudgeCredentialBinding {
  readonly refId: string;
  readonly destination: string;
  readonly available: boolean;
}

/** PROPOSED (#336/#337): the exact use a resolution is asked for, checked by the service against the binding. */
export interface JudgeCredentialUse {
  readonly purpose: typeof JUDGE_DISCLOSURE_PURPOSE;
  readonly destination: string;
  readonly grantRef: string;
}

/**
 * The resolved credential as the credential service shapes it for the sender. This module never inspects, copies,
 * serializes or retains it: it passes it from `withCredential` to the sender inside the same call.
 */
export type JudgeCredential = object;

/** PROPOSED (#336/#337): resolution only at the execution boundary, scoped to `consume`. */
export interface JudgeCredentialService {
  readonly describe: (ref: OpaqueCredentialRef, signal: AbortSignal) => Promise<JudgeCredentialBinding | null>;
  /**
   * Resolves for this one use and ends the lease when `consume` settles. Must refuse a use outside the binding.
   * `beforeHandoff`, when given, is the caller's last awaited check: a service awaits it after its own awaited
   * checks and the read, then makes its synchronous checks and calls `consume` in the same turn, which must
   * dispatch before it awaits anything.
   */
  readonly withCredential: <T>(
    ref: OpaqueCredentialRef,
    use: JudgeCredentialUse,
    signal: AbortSignal,
    consume: (credential: JudgeCredential) => Promise<T>,
    beforeHandoff?: () => Promise<void>,
  ) => Promise<T>;
}

/** Owner-injected sender for one destination: the only code that sees the frame and the credential together. */
export interface JudgeEndpointSender {
  readonly version: string;
  readonly destination: string;
  readonly capabilities: readonly string[];
  readonly send: (delivery: {
    readonly frame: string;
    readonly credential: JudgeCredential;
    readonly signal: AbortSignal;
    readonly maxResponseBytes: number;
  }) => Promise<string>;
}

/** The #746 limits plus an owner-declared budget, reserved per send and never refunded. */
export interface JudgeConnectionLimits extends EndpointJudgeLimits {
  readonly maxCostUnitsPerCall: number;
  readonly maxTotalCostUnits: number;
}

export interface JudgeConnectionDescriptor {
  readonly methodVersion: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly configVersion: string;
  readonly destination: string;
  readonly destinationPolicyRef: string;
  readonly projectionPolicyRevision: string;
  readonly credentialRef: OpaqueCredentialRef;
  readonly limits: JudgeConnectionLimits;
}

export type JudgeConnectionRefusal =
  | "cancelled"
  | "incomplete-config"
  | "destination-mismatch"
  | "capability-unsupported"
  | "disclosure-unavailable"
  | "disclosure-grant-missing"
  | "disclosure-grant-mismatch"
  | "disclosure-insufficient"
  | "disclosure-grant-expired"
  | "credential-binding-missing"
  | "credential-destination-mismatch"
  | "credential-unavailable";

/** Fixed send-time codes. The adapter reports every one as `transport-failed`; `refusals()` keeps which. */
export type JudgeSendRefusal =
  | "cancelled"
  | "projection-refused"
  | "concurrency-limit"
  | "budget-exhausted"
  | "disclosure-revoked"
  | "transport-failed";

export type PreparedJudgeConnection =
  | {
      readonly status: "prepared";
      readonly manifest: EndpointJudgeManifest;
      readonly limits: EndpointJudgeLimits;
      readonly transport: EndpointJudgeTransport;
      readonly configRef: string;
      /** The most recent send-time refusal codes, bounded; never a message, frame or credential. */
      readonly refusals: () => readonly JudgeSendRefusal[];
    }
  | { readonly status: "unavailable"; readonly reason: JudgeConnectionRefusal };

const descriptorKeys = [
  "methodVersion",
  "modelVersion",
  "promptVersion",
  "configVersion",
  "destination",
  "destinationPolicyRef",
  "projectionPolicyRevision",
] as const;
const limitKeys = [
  "maxPending",
  "maxCalls",
  "maxRequestBytes",
  "maxResponseBytes",
  "maxTimeoutMs",
  "maxCostUnitsPerCall",
  "maxTotalCostUnits",
] as const;
const queryKeys = [
  "purpose",
  "destination",
  "destinationPolicyRef",
  "projectionPolicyRevision",
  "methodVersion",
  "modelVersion",
  "promptVersion",
  "evidenceSchema",
] as const;
const MAX_REFUSALS = 32;

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const live = (expiresAt: unknown) => typeof expiresAt === "string" && Date.parse(expiresAt) > Date.now();

/** A fixed-code error: no message, cause or stack text from a service, sender or credential reaches the adapter. */
class SendRefused extends Error {
  constructor(readonly code: JudgeSendRefusal) {
    super(code);
    this.name = "JudgeSendRefused";
  }
}

/** Copies every descriptor field before awaiting; returns null when any required field is absent or not bounded. */
function snapshotDescriptor(descriptor: JudgeConnectionDescriptor): JudgeConnectionDescriptor | null {
  if (!record(descriptor) || !record(descriptor.limits) || !record(descriptor.credentialRef)) return null;
  const limits = Object.freeze(Object.fromEntries(limitKeys.map((key) => [key, descriptor.limits[key]])));
  const snapshot = Object.freeze({
    ...Object.fromEntries(descriptorKeys.map((key) => [key, descriptor[key]])),
    credentialRef: Object.freeze({ kind: descriptor.credentialRef.kind, id: descriptor.credentialRef.id }),
    limits,
  }) as unknown as JudgeConnectionDescriptor;
  if (!descriptorKeys.every((key) => text(snapshot[key]))) return null;
  if (snapshot.credentialRef.kind !== "credential-ref/v0" || !text(snapshot.credentialRef.id)) return null;
  const bounded = limitKeys.every((key) => Number.isSafeInteger(snapshot.limits[key]) && snapshot.limits[key] > 0);
  if (!bounded || snapshot.limits.maxTimeoutMs > 2_147_483_647) return null;
  if (snapshot.limits.maxCostUnitsPerCall > snapshot.limits.maxTotalCostUnits) return null;
  return snapshot;
}

/**
 * Explicit owner preparation. Every missing grant, binding, field or capability is `unavailable` with no
 * permissive fallback. Preparing contacts only the two metadata lookups: no credential is resolved and nothing is
 * sent, registered or activated.
 */
export async function prepareJudgeConnection(
  descriptor: JudgeConnectionDescriptor,
  services: {
    readonly grants: JudgeDisclosureGrantService;
    readonly credentials: JudgeCredentialService;
    readonly sender: JudgeEndpointSender;
  },
  signal: AbortSignal,
): Promise<PreparedJudgeConnection> {
  const refuse = (reason: JudgeConnectionRefusal) => Object.freeze({ status: "unavailable" as const, reason });
  if (signal.aborted) return refuse("cancelled");
  const selected = snapshotDescriptor(descriptor);
  if (selected === null) return refuse("incomplete-config");
  // Capture each injected function and its metadata once; later caller mutation cannot redirect delivery.
  const { grants, credentials, sender } = services;
  const find = grants.find;
  const current = grants.current;
  const describe = credentials.describe;
  const withCredential = credentials.withCredential;
  const send = sender.send;
  const senderVersion = sender.version;
  const senderDestination = sender.destination;
  const capabilities = Array.isArray(sender.capabilities) ? [...sender.capabilities] : [];
  if (![find, current, describe, withCredential, send].every((fn) => typeof fn === "function") || !text(senderVersion))
    return refuse("incomplete-config");
  if (senderDestination !== selected.destination) return refuse("destination-mismatch");
  if (!REQUIRED_SENDER_CAPABILITIES.every((capability) => capabilities.includes(capability)))
    return refuse("capability-unsupported");

  const query: JudgeDisclosureQuery = Object.freeze({
    purpose: JUDGE_DISCLOSURE_PURPOSE,
    destination: selected.destination,
    destinationPolicyRef: selected.destinationPolicyRef,
    projectionPolicyRevision: selected.projectionPolicyRevision,
    methodVersion: selected.methodVersion,
    modelVersion: selected.modelVersion,
    promptVersion: selected.promptVersion,
    evidenceSchema: LOCAL_EVIDENCE_SCHEMA,
  });
  let found: unknown;
  try {
    found = await find(query, signal);
  } catch {
    return refuse(signal.aborted ? "cancelled" : "disclosure-unavailable");
  }
  if (signal.aborted) return refuse("cancelled");
  if (found === null) return refuse("disclosure-grant-missing");
  if (!record(found) || !queryKeys.every((key) => found[key] === query[key]))
    return refuse("disclosure-grant-mismatch");
  if (!text(found.grantRef) || !text(found.revision) || !Array.isArray(found.fields))
    return refuse("disclosure-grant-mismatch");
  const grantRef = found.grantRef;
  const grantRevision = found.revision;
  const grantFields: readonly unknown[] = [...(found.fields as unknown[])];
  // The adapter's frame is already the minimum it can send; a grant that withholds any part of it is unsupported.
  if (!ENDPOINT_FRAME_FIELDS.every((field) => grantFields.includes(field))) return refuse("disclosure-insufficient");
  if (!live(found.expiresAt)) return refuse("disclosure-grant-expired");

  let binding: unknown;
  try {
    binding = await describe(selected.credentialRef, signal);
  } catch {
    return refuse(signal.aborted ? "cancelled" : "credential-unavailable");
  }
  if (signal.aborted) return refuse("cancelled");
  if (!record(binding) || binding.refId !== selected.credentialRef.id) return refuse("credential-binding-missing");
  if (binding.destination !== selected.destination) return refuse("credential-destination-mismatch");
  if (binding.available !== true) return refuse("credential-unavailable");

  // The credential binding, grant revision, sender and budget are folded into the transport version, which the
  // adapter's config ref covers: changing any of them changes the ref that policy must select.
  const transportVersion = `${JUDGE_CONNECTION_SCHEMA}:sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        JUDGE_CONNECTION_SCHEMA,
        senderVersion,
        senderDestination,
        [...REQUIRED_SENDER_CAPABILITIES],
        selected.credentialRef.id,
        grantRef,
        grantRevision,
        selected.limits.maxCostUnitsPerCall,
        selected.limits.maxTotalCostUnits,
      ]),
    )
    .digest("hex")}`;
  const manifest: EndpointJudgeManifest = Object.freeze({
    methodVersion: selected.methodVersion,
    modelVersion: selected.modelVersion,
    promptVersion: selected.promptVersion,
    configVersion: selected.configVersion,
    transportVersion,
    inputSchema: LOCAL_EVIDENCE_SCHEMA,
    outputSchema: LOCAL_ADVICE_SCHEMA,
    destination: selected.destination,
    destinationPolicyRef: selected.destinationPolicyRef,
    projectionPolicyRevision: selected.projectionPolicyRevision,
    // The adapter and method still hold no credential; the binding lives only behind this transport.
    credential: "none",
  });
  const limits: EndpointJudgeLimits = Object.freeze({
    maxPending: selected.limits.maxPending,
    maxCalls: selected.limits.maxCalls,
    maxRequestBytes: selected.limits.maxRequestBytes,
    maxResponseBytes: selected.limits.maxResponseBytes,
    maxTimeoutMs: selected.limits.maxTimeoutMs,
  });
  const use: JudgeCredentialUse = Object.freeze({
    purpose: JUDGE_DISCLOSURE_PURPOSE,
    destination: selected.destination,
    grantRef,
  });

  const credentialRef = selected.credentialRef;
  const perCall = selected.limits.maxCostUnitsPerCall;
  const budget = selected.limits.maxTotalCostUnits;
  const refusals: JudgeSendRefusal[] = [];
  const refused = (code: JudgeSendRefusal) => {
    refusals.push(code);
    if (refusals.length > MAX_REFUSALS) refusals.shift();
    return new SendRefused(code);
  };
  let inFlight = 0;
  let spent = 0;

  /** Reads the grant's current state. The checks on it are `admit`'s, run where the state is used. */
  async function readGrant(callSignal: AbortSignal): Promise<unknown> {
    if (callSignal.aborted) throw refused("cancelled");
    try {
      return await current(grantRef, callSignal);
    } catch {
      throw refused(callSignal.aborted ? "cancelled" : "disclosure-revoked");
    }
  }

  /**
   * Synchronous on purpose: the grant must be at its prepared revision and unexpired, and the call not cancelled,
   * in the same turn as the action it admits. No await may come between this and that action.
   */
  function admit(state: unknown, callSignal: AbortSignal): void {
    if (callSignal.aborted) throw refused("cancelled");
    if (!record(state) || state.revision !== grantRevision || !live(state.expiresAt))
      throw refused("disclosure-revoked");
  }

  /** Rechecks the projection, budget and grant, then the grant again once the credential resolves, for one send. */
  async function deliver(frame: string, callSignal: AbortSignal, maxResponseBytes: number): Promise<string> {
    if (callSignal.aborted) throw refused("cancelled");
    let sent: unknown;
    try {
      sent = typeof frame === "string" ? JSON.parse(frame) : undefined;
    } catch {
      sent = undefined;
    }
    if (
      typeof frame !== "string" ||
      Buffer.byteLength(frame, "utf8") > limits.maxRequestBytes ||
      maxResponseBytes !== limits.maxResponseBytes ||
      !exactKeys(sent, ENDPOINT_FRAME_FIELDS) ||
      frame !== JSON.stringify(Object.fromEntries(ENDPOINT_FRAME_FIELDS.map((key) => [key, sent[key]]))) ||
      sent.schema !== ENDPOINT_REQUEST_SCHEMA ||
      !text(sent.requestId) ||
      sent.model !== manifest.modelVersion ||
      sent.prompt !== manifest.promptVersion ||
      sent.evidenceSchema !== LOCAL_EVIDENCE_SCHEMA ||
      typeof sent.evidence !== "string"
    )
      throw refused("projection-refused");
    if (inFlight >= limits.maxPending) throw refused("concurrency-limit");
    if (spent + perCall > budget) throw refused("budget-exhausted");
    // Reserved before any await and never refunded: a cancelled call may still have been billed.
    spent += perCall;
    inFlight++;
    try {
      admit(await readGrant(callSignal), callSignal);
      let reply: unknown;
      // Set only by the checks inside the lease, so a sender's own error can never borrow its code.
      let gated: SendRefused | undefined;
      try {
        // Read the disclosure grant last, from the service's hand-off hook, so every awaited check is done before
        // the service's own synchronous checks and this callback's `admit` + `send` run in one turn. A service
        // that never calls the hook gets the older order: the grant is read inside the callback instead.
        let state: unknown;
        let read = false;
        const beforeHandoff = async () => {
          try {
            state = await readGrant(callSignal);
            read = true;
          } catch (error) {
            gated = error as SendRefused;
            throw error;
          }
        };
        reply = await withCredential(
          credentialRef,
          use,
          callSignal,
          async (credential) => {
            try {
              if (!read) state = await readGrant(callSignal);
              // `admit` and the sender call below run in one synchronous turn, so no queued work can let the
              // grant lapse or the call be cancelled between the check and the send.
              admit(state, callSignal);
            } catch (error) {
              gated = error as SendRefused;
              throw error;
            }
            return send({ frame, credential, signal: callSignal, maxResponseBytes });
          },
          beforeHandoff,
        );
      } catch {
        if (gated) throw gated;
        throw refused(callSignal.aborted ? "cancelled" : "transport-failed");
      }
      // A reply that arrives after cancellation or timeout is dropped here, not only by the adapter.
      if (callSignal.aborted) throw refused("cancelled");
      if (typeof reply !== "string") throw refused("transport-failed");
      return reply;
    } finally {
      inFlight--;
    }
  }

  const transport: EndpointJudgeTransport = Object.freeze({
    version: transportVersion,
    destination: selected.destination,
    send: (frame: string, callSignal: AbortSignal, maxResponseBytes: number) =>
      deliver(frame, callSignal, maxResponseBytes),
  });
  return Object.freeze({
    status: "prepared" as const,
    manifest,
    limits,
    transport,
    configRef: endpointJudgeConfigRef(manifest, limits),
    refusals: () => Object.freeze([...refusals]),
  });
}
