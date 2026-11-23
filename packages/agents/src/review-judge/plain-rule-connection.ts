/**
 * Assembling a plain-language rule judge from configuration (#701): the configured provider, the HTTPS sender for
 * its pinned destination, and the person's own key through the #336 secret lease, composed into one
 * `JudgePermission`. Inactive: nothing here reads ORCA's config, registers the judge or calls it. The evaluation
 * slot and its activation are separate, reviewed steps.
 *
 *   review.plainRules.judge:
 *     provider: { kind: anthropic }                 # or { kind: openai-compatible, model: ... }
 *     destination: https://api.anthropic.com/v1/messages
 *     credential: judge-key                         # a `secrets:` entry pinned to that destination
 *     limits: { timeoutMs: 5000, maxCallsPerDay: 200 }
 *
 * Preparation is fail-closed and contacts only two metadata lookups: the credential binding (`describe`) and the
 * disclosure grant (`find`). No key is read and nothing is sent until the judge is called. At every call:
 * - the daily budget is reserved first and never refunded (over it the call fails, which the judge reports as
 *   `unavailable`, so the person is asked). It comes from the injected `JudgeBudget`: `daemonJudgeBudget` is shared
 *   by every judge using the same key and destination and survives restarts; `memoryJudgeBudget` (tests) does
 *   not. `durableBudget` is true only for a budget qualified by a reviewed daemon integration (none yet), and
 *   activation requires it;
 * - the key is leased for that one request only, for purpose `review-judge` and the pinned destination;
 * - the disclosure grant is rechecked as the lease's last awaited step, and again synchronously at the dispatch
 *   itself (`currentNow`), with the call's cancellation, in the turn that calls the sender. The send happens only
 *   after both pass; a revoked, expired or changed grant, or a cancelled call, stops it.
 *
 * The provider is resolved once into one frozen object. The disclosure query names its version, and the sender's
 * key placement and headers and every request body come from that same object.
 * Every refusal is a fixed code, never a value or provider text.
 */
import { createHash } from "node:crypto";
import {
  JUDGE_DISCLOSURE_PURPOSE,
  REQUIRED_SENDER_CAPABILITIES,
  type JudgeCredentialService,
  type JudgeEndpointSender,
} from "./connection.js";
import { createHttpsJudgeSender, type HttpsRequestFn } from "./https-sender.js";
import {
  createPlainRuleJudge,
  DEFAULT_PLAIN_RULE_LIMITS,
  PLAIN_RULE_REQUEST_SCHEMA,
  plainRuleJudgeConfigRef,
  type JudgePermission,
  type PlainRuleJudgeLimits,
  type PlainRuleTransport,
} from "./plain-rule.js";
import {
  createPlainRuleProviderTransport,
  plainRuleProviderSenderOptions,
  type PlainRuleProviderConfig,
  type ResolvedPlainRuleProvider,
} from "./plain-rule-providers.js";
import { judgeBudgetKey, type JudgeBudget } from "./judge-budget.js";
import { judgeSecretRef } from "./secret-credentials.js";

export const PLAIN_RULE_CONNECTION_SCHEMA = "orca-701-plain-rule-connection/v1";

/** `review.plainRules.judge`, as the person writes it. */
export interface PlainRuleJudgeConfig {
  readonly provider: PlainRuleProviderConfig;
  /** The exact URL the key is pinned to (the secret's `destination`). */
  readonly destination: string;
  /** The id of a `secrets:` entry pinned to `destination`. */
  readonly credential: string;
  readonly limits?: {
    /** Default 5000. */
    readonly timeoutMs?: number;
    /**
     * Default 200. Counted per UTC day, reserved per call and never refunded, in the injected budget: committed and
     * shared per key and destination with `daemonJudgeBudget`.
     */
    readonly maxCallsPerDay?: number;
  };
}

/** What a disclosure grant for plain-rule judging is asked for: this destination, this provider and wire format. */
export interface PlainRuleDisclosureQuery {
  readonly purpose: typeof JUDGE_DISCLOSURE_PURPOSE;
  readonly destination: string;
  readonly providerVersion: string;
  readonly requestSchema: typeof PLAIN_RULE_REQUEST_SCHEMA;
}

export interface PlainRuleDisclosureGrant extends PlainRuleDisclosureQuery {
  readonly grantRef: string;
  readonly revision: string;
  readonly expiresAt: string;
}

/** Lookup only: it can neither create nor widen a grant. Null means no approved grant. */
export interface PlainRuleDisclosureService {
  readonly find: (query: PlainRuleDisclosureQuery, signal: AbortSignal) => Promise<PlainRuleDisclosureGrant | null>;
  /** The grant's current state, rechecked before every send; null once it is revoked or unknown. */
  readonly current: (
    grantRef: string,
    signal: AbortSignal,
  ) => Promise<{ readonly revision: string; readonly expiresAt: string } | null>;
  /**
   * The same answer, synchronously, from the grant store as it is at that moment. Asked at the dispatch itself,
   * after every awaited step, in the turn that calls the sender: a grant revoked while anything was awaited stops it.
   */
  readonly currentNow: (grantRef: string) => { readonly revision: string; readonly expiresAt: string } | null;
}

export type PlainRuleConnectionRefusal =
  | "cancelled"
  | "incomplete-config"
  | "provider-invalid"
  | "destination-invalid"
  | "capability-unsupported"
  | "credential-binding-missing"
  | "credential-destination-mismatch"
  | "credential-unavailable"
  | "disclosure-unavailable"
  | "disclosure-grant-missing"
  | "disclosure-grant-mismatch"
  | "disclosure-grant-expired";

export type PreparedPlainRuleJudge =
  | {
      readonly status: "prepared";
      readonly judge: JudgePermission;
      /** The ref every decision records: changes with the provider, sender, key binding, grant and limits. */
      readonly judgeConfigRef: string;
      readonly provider: ResolvedPlainRuleProvider;
      /** Whether the daily budget is shared and survives restarts. Activation requires `true`. */
      readonly durableBudget: boolean;
    }
  | { readonly status: "unavailable"; readonly reason: PlainRuleConnectionRefusal };

/** Why one call failed before or at the send. The judge reports each as `unavailable`. */
export class PlainRuleSendRefused extends Error {
  constructor(readonly code: "daily-budget" | "disclosure-revoked") {
    super(`plain-rule send refused: ${code}`);
    this.name = "PlainRuleSendRefused";
  }
}

/** A provider envelope around a verdict is larger than the verdict; still bounded. */
const MAX_PROVIDER_RESPONSE_BYTES = 65_536;
const QUERY_KEYS = ["purpose", "destination", "providerVersion", "requestSchema"] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const live = (expiresAt: unknown, now: number) =>
  text(expiresAt) && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > now;
const positiveInt = (value: unknown, max: number) =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;

function selectConfig(config: unknown):
  | {
      readonly provider: unknown;
      readonly destination: string;
      readonly credential: string;
      readonly timeoutMs: number;
      readonly maxCallsPerDay: number;
    }
  | undefined {
  // One snapshot of what the caller passed: later mutation, or a getter answering twice, cannot change it.
  let snapshot: unknown;
  try {
    snapshot = structuredClone(config);
  } catch {
    return undefined;
  }
  if (!record(snapshot)) return undefined;
  const { provider, destination, credential, limits } = snapshot;
  if (!text(destination) || !text(credential) || !/^[A-Za-z0-9_.-]{1,128}$/.test(credential)) return undefined;
  if (limits !== undefined && !record(limits)) return undefined;
  const timeoutMs = limits?.timeoutMs ?? DEFAULT_PLAIN_RULE_LIMITS.timeoutMs;
  const maxCallsPerDay = limits?.maxCallsPerDay ?? DEFAULT_PLAIN_RULE_LIMITS.maxCalls;
  if (!positiveInt(timeoutMs, 60_000) || !positiveInt(maxCallsPerDay, 100_000)) return undefined;
  if (limits && Object.keys(limits).some((key) => key !== "timeoutMs" && key !== "maxCallsPerDay")) return undefined;
  if (Object.keys(snapshot).some((key) => !["provider", "destination", "credential", "limits"].includes(key)))
    return undefined;
  return Object.freeze({
    provider,
    destination,
    credential,
    timeoutMs: timeoutMs as number,
    maxCallsPerDay: maxCallsPerDay as number,
  });
}

/**
 * Explicit owner preparation of a plain-rule judge. Every missing or mismatched piece is `unavailable`, with no
 * permissive fallback. The returned judge is not registered anywhere.
 */
export async function preparePlainRuleJudge(
  config: unknown,
  services: {
    readonly credentials: JudgeCredentialService;
    readonly disclosure: PlainRuleDisclosureService;
    /**
     * The daily call budget. Activation requires a qualified durable one, which only a reviewed daemon integration
     * provides; `daemonJudgeBudget` alone is shared and committed but reports `durable: false`.
     */
    readonly budget: JudgeBudget;
    /** Tests inject the HTTPS request function and the clock. */
    readonly request?: HttpsRequestFn;
    readonly now?: () => number;
  },
  signal: AbortSignal,
): Promise<PreparedPlainRuleJudge> {
  const refuse = (reason: PlainRuleConnectionRefusal): PreparedPlainRuleJudge =>
    Object.freeze({ status: "unavailable" as const, reason });
  if (signal.aborted) return refuse("cancelled");
  const selected = selectConfig(config);
  if (selected === undefined) return refuse("incomplete-config");
  // Capture each injected function once; later caller mutation cannot redirect delivery.
  const { credentials, disclosure } = services ?? {};
  const describe = credentials?.describe;
  const withCredential = credentials?.withCredential;
  const find = disclosure?.find;
  const current = disclosure?.current;
  const currentNow = disclosure?.currentNow;
  const budget = services?.budget;
  const now = services?.now ?? Date.now;
  if (
    typeof describe !== "function" ||
    typeof withCredential !== "function" ||
    typeof find !== "function" ||
    typeof current !== "function" ||
    typeof currentNow !== "function" ||
    typeof budget?.reserve !== "function" ||
    typeof now !== "function"
  )
    return refuse("incomplete-config");

  // One normalized provider, resolved once and frozen. The disclosure query, the sender's key placement and headers,
  // and every request body all come from this same object, so the choice approved is the choice used.
  const destination = selected.destination;
  const maxCallsPerDay = selected.maxCallsPerDay;
  const made = createPlainRuleProviderTransport({ config: selected.provider, post: (body, s) => post(body, s) });
  if (made.status !== "ready") return refuse("provider-invalid");
  const provider = made.provider;
  const providerTransport = made.transport;
  const senderResult = createHttpsJudgeSender({
    destination: selected.destination,
    ...plainRuleProviderSenderOptions(provider.kind),
    ...(services.request ? { request: services.request } : {}),
  });
  if (senderResult.status !== "ready") return refuse("destination-invalid");
  const sender: JudgeEndpointSender = senderResult.sender;
  const send = sender.send;
  const senderVersion = sender.version;
  if (sender.destination !== selected.destination) return refuse("destination-invalid");
  if (!REQUIRED_SENDER_CAPABILITIES.every((capability) => sender.capabilities.includes(capability)))
    return refuse("capability-unsupported");

  // The key's binding: it must name this destination and be usable here. No value is read.
  const ref = judgeSecretRef(selected.credential);
  let binding: unknown;
  try {
    binding = await describe(ref, signal);
  } catch {
    return refuse(signal.aborted ? "cancelled" : "credential-unavailable");
  }
  if (signal.aborted) return refuse("cancelled");
  if (!record(binding) || binding.refId !== ref.id) return refuse("credential-binding-missing");
  if (binding.destination !== selected.destination) return refuse("credential-destination-mismatch");
  if (binding.available !== true) return refuse("credential-unavailable");

  // The disclosure grant: the person's approval that actions may be sent to this destination for judging.
  const query: PlainRuleDisclosureQuery = Object.freeze({
    purpose: JUDGE_DISCLOSURE_PURPOSE,
    destination: selected.destination,
    providerVersion: providerTransport.version,
    requestSchema: PLAIN_RULE_REQUEST_SCHEMA,
  });
  let found: unknown;
  try {
    found = await find(query, signal);
  } catch {
    return refuse(signal.aborted ? "cancelled" : "disclosure-unavailable");
  }
  if (signal.aborted) return refuse("cancelled");
  if (found === null) return refuse("disclosure-grant-missing");
  if (!record(found) || !QUERY_KEYS.every((key) => found[key] === query[key]))
    return refuse("disclosure-grant-mismatch");
  if (!text(found.grantRef) || !text(found.revision)) return refuse("disclosure-grant-mismatch");
  if (!live(found.expiresAt, now())) return refuse("disclosure-grant-expired");
  const grant = Object.freeze({ ref: found.grantRef, revision: found.revision });

  // The call budget, per UTC day, reserved before the key is leased and never refunded. Shared by every judge using
  // this key for this destination when the budget is durable (`daemonJudgeBudget`).
  const budgetKey = judgeBudgetKey(destination, ref.id);
  const reserve = budget.reserve;
  async function post(body: string, callSignal: AbortSignal): Promise<string> {
    // Only ever called after preparation finished, so the approved grant below is set.
    const use = grant;
    const unchanged = (state: unknown) =>
      record(state) && state.revision === use.revision && live(state.expiresAt, now());
    if (!(await reserve(budgetKey, maxCallsPerDay))) throw new PlainRuleSendRefused("daily-budget");
    let handedOff = false;
    return withCredential(
      ref,
      Object.freeze({ purpose: JUDGE_DISCLOSURE_PURPOSE, destination, grantRef: use.ref }),
      callSignal,
      (credential) => {
        // The dispatch boundary, synchronous and in the turn that calls the sender: the awaited recheck must have
        // passed, the call must still be live, and the grant must still be the approved, unexpired revision now.
        if (!handedOff || callSignal.aborted) throw new PlainRuleSendRefused("disclosure-revoked");
        let state: unknown;
        try {
          state = currentNow(use.ref);
        } catch {
          throw new PlainRuleSendRefused("disclosure-revoked");
        }
        if (!unchanged(state)) throw new PlainRuleSendRefused("disclosure-revoked");
        return send({ frame: body, credential, signal: callSignal, maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES });
      },
      async () => {
        const state = await current(use.ref, callSignal);
        if (callSignal.aborted || !unchanged(state)) throw new PlainRuleSendRefused("disclosure-revoked");
        handedOff = true;
      },
    );
  }

  // The sender, key binding, grant and budget fold into the transport version, which the judge's config ref covers.
  const transport: PlainRuleTransport = Object.freeze({
    version: `${PLAIN_RULE_CONNECTION_SCHEMA}:sha256:${createHash("sha256")
      .update(
        JSON.stringify([
          PLAIN_RULE_CONNECTION_SCHEMA,
          providerTransport.version,
          senderVersion,
          selected.destination,
          ref.id,
          grant.ref,
          grant.revision,
          selected.maxCallsPerDay,
          budgetKey,
          budget.durable === true,
        ]),
      )
      .digest("hex")}`,
    send: providerTransport.send,
  });
  const limits: PlainRuleJudgeLimits = Object.freeze({
    ...DEFAULT_PLAIN_RULE_LIMITS,
    timeoutMs: selected.timeoutMs,
    // The per-day budget above is the call limit; this only bounds one prepared judge's lifetime.
    maxCalls: Number.MAX_SAFE_INTEGER,
  });
  return Object.freeze({
    status: "prepared" as const,
    judge: createPlainRuleJudge({ transport, limits }),
    judgeConfigRef: plainRuleJudgeConfigRef(transport.version, limits),
    provider,
    durableBudget: budget.durable === true,
  });
}
