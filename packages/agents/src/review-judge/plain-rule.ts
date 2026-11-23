/**
 * The judge for plain-language permission rules (#701, design: docs/preparation/review-judge-701/plain-language-rules.md).
 *
 * A judged permission rule pairs a deterministic `match` with a `criterion` the person wrote. The evaluation slot
 * (#702, `permissions.ts`) collects the judged rules an ask reaches, in first-match order (those whose `match` holds,
 * up to the first typed rule that matches), and calls `judgePermission` once for all of them. The judge returns a
 * verdict per rule; the earliest rule with a clear, well-formed "covered" allows, which is what judging them one by
 * one in order would give. The answer is only `allow` or `no-match`: the judge never denies, and anything short of
 * that is `no-match`, so the next typed rule or the default decides. This module:
 *
 * - asks nothing when a deterministic deny or mandatory-human rule matches the action anywhere in the policy
 *   (`hard-boundary`), or when the action is outside the first-rollout envelope: a known read-only kind whose real
 *   targets ORCA verified inside the workspace and outside protected paths (`outside-envelope`). Commands and writes
 *   always go to the person for now. The flags are the output of the slot's trusted checks, never a substitute for
 *   them; the judge can only allow inside them;
 * - builds the request itself from the rule and the action, carrying the agent-controlled command as a JSON string,
 *   never as instructions, capped in size, and refuses obvious injection tripwires without asking the judge;
 * - decodes a closed reply that must echo this request id, rule id and revision;
 * - bounds every call by a deadline, a concurrency cap and a call budget, all reserved before any await;
 * - never throws, and returns no command text, criterion or model prose: a reason is a fixed code, worded locally.
 *
 * The transport is owner-injected. Tests use deterministic fakes. A real provider comes with the reviewed HTTPS
 * sender and the BYOK credentials (#964). Nothing here is registered or switched on, and it stays inactive until
 * the real sender and the evaluation slot have had their own independent review.
 */
import { createHash, randomUUID } from "node:crypto";

export const PLAIN_RULE_REQUEST_SCHEMA = "orca-plain-rule-request/v1";
export const PLAIN_RULE_VERDICT_SCHEMA = "orca-plain-rule-verdict/v1";

export interface PlainRuleCandidate {
  readonly ruleId: string;
  readonly ruleRevision: string;
  readonly criterion: string;
}

export interface PlainRuleJudgeInput {
  /** The judged rules this ask reaches, in first-match order. Each one's deterministic `match` already holds. */
  readonly rules: readonly PlainRuleCandidate[];
  /**
   * Whether any deterministic `deny` or mandatory-human (`ask`) rule in the whole policy matches this action,
   * wherever it sits in the order. Either one closes the judged lane: no rule order lets a judge allow an action
   * the person reserved for themselves or explicitly denied. Both must be exactly `false` to proceed.
   */
  readonly restrictions: { readonly deny: boolean; readonly ask: boolean };
  readonly action: {
    readonly kind: string;
    /** The tool call title. Agent-controlled. */
    readonly title: string;
    /** The call's targets, workspace-relative. */
    readonly locations: readonly string[];
    readonly inWorkspace: boolean;
    /**
     * The output of the slot's trusted check, never a claim from the agent or the tool: true only when ORCA itself
     * resolved every target's real path (symlinks followed, as the read will open it) and found it inside the
     * workspace and outside every protected path. A tool-reported working directory or a lexically relative path
     * is not enough. Anything else goes to the person.
     */
    readonly targetsVerified: boolean;
  };
}

/**
 * Tool kinds a judged rule may allow in the first rollout: known read-only operations only. Commands (`execute`)
 * and writes (`edit`, `delete`, `move`) have no verified effect evidence yet and always go to the person, as do
 * fetches, mode switches and unknown kinds.
 */
export const PLAIN_RULE_JUDGED_KINDS: ReadonlySet<string> = new Set(["read", "search"]);

/**
 * Fixed reasons a judge may give, one family per verdict. Never model prose: the wording a person sees is ORCA's
 * own (`PLAIN_RULE_REASON_TEXT`), so a reply cannot echo the command or the criterion into a prompt or the audit.
 */
export const PLAIN_RULE_REASONS = Object.freeze({
  covered: ["matches-criterion"],
  "not-covered": ["outside-criterion", "excluded-by-criterion"],
  unsure: ["action-ambiguous", "criterion-ambiguous"],
} as const);
export type PlainRuleReasonCode = (typeof PLAIN_RULE_REASONS)[keyof typeof PLAIN_RULE_REASONS][number];

/** Local wording for each reason code. */
export const PLAIN_RULE_REASON_TEXT: Readonly<Record<PlainRuleReasonCode, string>> = Object.freeze({
  "matches-criterion": "Your rule covers this.",
  "outside-criterion": "Your rule doesn't cover this.",
  "excluded-by-criterion": "Your rule excludes this.",
  "action-ambiguous": "It isn't clear what this would do.",
  "criterion-ambiguous": "It isn't clear whether your rule covers this.",
});

export type PlainRuleVerdict =
  | "covered"
  | "not-covered"
  | "unsure"
  | "unavailable"
  | "malformed"
  | "timeout"
  | "over-budget"
  | "injection-suspected"
  | "hard-boundary"
  | "outside-envelope";

export interface PlainRuleJudgeOutcome {
  readonly outcome: "allow" | "no-match";
  /**
   * With `allow`: `covered`. Otherwise a refusal before any call (`hard-boundary`, `outside-envelope`,
   * `injection-suspected`, `over-budget`), the call's own failure (`unavailable`, `malformed`, `timeout`) or, from
   * a well-formed reply that covers nothing, `not-covered` / `unsure` (unsure when any rule was unsure).
   */
  readonly verdict: PlainRuleVerdict;
  /** With `allow`: the rule that allowed, which the slot re-reads before answering. */
  readonly ruleId?: string;
  readonly ruleRevision?: string;
  /** From a well-formed reply: the deciding rule's reason code (the first unsure, or the first rule's). */
  readonly reasonCode?: PlainRuleReasonCode;
  /** Every judged rule's verdict and reason code, in the order sent, from a well-formed reply. Empty otherwise. */
  readonly verdicts: readonly {
    readonly ruleId: string;
    readonly verdict: "covered" | "not-covered" | "unsure";
    readonly reasonCode: PlainRuleReasonCode;
  }[];
  /** Which transport, schema and limits decided: recorded with every decision. */
  readonly judgeConfigRef: string;
}

/** Owner-injected delivery of one request frame to one judge; returns the raw reply text. */
export interface PlainRuleTransport {
  readonly version: string;
  readonly send: (frame: string, signal: AbortSignal) => Promise<string>;
}

export interface PlainRuleJudgeLimits {
  /** Per call, including the transport. Over it is `timeout`. */
  readonly timeoutMs: number;
  /**
   * Sends outstanding at once, each held until the send itself settles (not when the caller stops waiting). Over it
   * is `over-budget`, never a queue.
   */
  readonly maxPending: number;
  /** Calls this judge may ever make. Reserved per call and never refunded. */
  readonly maxCalls: number;
  /** UTF-8 bytes of the command text. Over it is `injection-suspected`, without a call. */
  readonly maxCommandBytes: number;
  /** UTF-8 bytes of a reply. Over it is `malformed`. */
  readonly maxReplyBytes: number;
  /** Rules judged in one call. Rules past it in order are not sent and cannot allow (the slot's next rule decides). */
  readonly maxRules: number;
}

export const DEFAULT_PLAIN_RULE_LIMITS: PlainRuleJudgeLimits = Object.freeze({
  timeoutMs: 5_000,
  maxPending: 2,
  maxCalls: 200,
  maxCommandBytes: 4_096,
  maxReplyBytes: 16_384,
  maxRules: 20,
});

export type JudgePermission = (input: PlainRuleJudgeInput, signal: AbortSignal) => Promise<PlainRuleJudgeOutcome>;

const TIMED_OUT = Symbol("timed-out");
const CANCELLED = Symbol("cancelled");
const MAX_CRITERION_BYTES = 2_048;
const MAX_LOCATIONS = 32;
const REPLY_KEYS = ["schema", "requestId", "verdicts"] as const;
const ENTRY_KEYS = ["ruleId", "ruleRevision", "verdict", "reasonCode"] as const;
const JUDGE_VERDICTS = new Set(["covered", "not-covered", "unsure"]);
const reasonFits = (verdict: string, code: string) =>
  Object.hasOwn(PLAIN_RULE_REASONS, verdict) &&
  (PLAIN_RULE_REASONS[verdict as keyof typeof PLAIN_RULE_REASONS] as readonly string[]).includes(code);

/**
 * Text that addresses a reviewer rather than a shell, or carries control characters that can hide it. A command
 * containing any of these is not sent: it is `injection-suspected`, which is `no-match`. A tripwire, not a defence
 * on its own and not an authorization boundary: the restrictions, the safe envelope and the rule's deterministic
 * `match` are what bound a false `covered`.
 */
const TRIPWIRES = [
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u,
  /ignore (all |any )?(previous|prior|above|earlier)/i,
  /disregard (all |any )?(previous|prior|above|earlier)/i,
  /\byou are (now )?(a|an|the)\b/i,
  /\b(system|assistant|developer) ?(prompt|message|:)/i,
  /orca-plain-rule-(request|verdict)/i,
  /\bverdict\b\s*["':=]/i,
  /\bcovered\b\s*["':=]/i,
];

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const positive = (value: unknown, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;

function validLimits(limits: PlainRuleJudgeLimits): boolean {
  return (
    positive(limits.timeoutMs, 2_147_483_647) &&
    positive(limits.maxPending) &&
    positive(limits.maxCalls) &&
    positive(limits.maxCommandBytes) &&
    positive(limits.maxReplyBytes) &&
    positive(limits.maxRules, 100)
  );
}

/** The ref a decision records: changes with the transport, the wire schemas and every limit. */
export function plainRuleJudgeConfigRef(transportVersion: string, limits: PlainRuleJudgeLimits): string {
  const fields = [
    PLAIN_RULE_REQUEST_SCHEMA,
    PLAIN_RULE_VERDICT_SCHEMA,
    transportVersion,
    limits.timeoutMs,
    limits.maxPending,
    limits.maxCalls,
    limits.maxCommandBytes,
    limits.maxReplyBytes,
    limits.maxRules,
  ];
  return `plain-rule-judge/v1:sha256:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}

/** Copies the input before any await and checks its shape. Null when anything is missing or out of bounds. */
function snapshot(input: PlainRuleJudgeInput, limits: PlainRuleJudgeLimits) {
  if (input === null || typeof input !== "object" || input.action === null || typeof input.action !== "object")
    return null;
  if (!Array.isArray(input.rules) || input.rules.length === 0) return null;
  const rules: PlainRuleCandidate[] = [];
  const seen = new Set<string>();
  for (const rule of (input.rules as unknown[]).slice(0, limits.maxRules)) {
    if (rule === null || typeof rule !== "object") return null;
    const { ruleId, ruleRevision, criterion } = rule as Record<string, unknown>;
    if (!text(ruleId) || !text(ruleRevision) || !text(criterion) || bytes(criterion) > MAX_CRITERION_BYTES) return null;
    if (seen.has(ruleId)) return null;
    seen.add(ruleId);
    rules.push({ ruleId, ruleRevision, criterion });
  }
  const restrictions = input.restrictions as unknown;
  if (restrictions === null || typeof restrictions !== "object") return null;
  const { deny, ask } = restrictions as Record<string, unknown>;
  if (typeof deny !== "boolean" || typeof ask !== "boolean") return null;
  const { kind, title, locations, inWorkspace, targetsVerified } = input.action;
  if (!text(kind) || typeof title !== "string" || typeof inWorkspace !== "boolean") return null;
  if (typeof targetsVerified !== "boolean") return null;
  if (!Array.isArray(locations) || locations.length > MAX_LOCATIONS) return null;
  const copied = [...(locations as unknown[])];
  if (!copied.every((l): l is string => typeof l === "string" && bytes(l) <= limits.maxCommandBytes)) return null;
  return {
    rules,
    restricted: deny || ask,
    targetsVerified,
    action: { kind, title, locations: copied, inWorkspace },
  };
}

/** A workspace-relative path with no way out of the workspace: not absolute, no `..`, no home or drive prefix. */
function workspaceRelative(path: string): boolean {
  if (path.length === 0 || /^[/\\~]/.test(path) || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[/\\]/).some((part) => part === "..");
}

/**
 * The first-rollout envelope: a known read-only kind, at least one target, every target verified by ORCA, and (as
 * a second, lexical line behind that check) every location workspace-relative. Absent or ambiguous facts are
 * outside it.
 */
function insideEnvelope(selected: NonNullable<ReturnType<typeof snapshot>>): boolean {
  const { action } = selected;
  if (selected.targetsVerified !== true || action.inWorkspace !== true) return false;
  if (!PLAIN_RULE_JUDGED_KINDS.has(action.kind)) return false;
  if (action.locations.length === 0) return false;
  return action.locations.every(workspaceRelative);
}

type Entry = {
  ruleId: string;
  ruleRevision: string;
  verdict: "covered" | "not-covered" | "unsure";
  reasonCode: PlainRuleReasonCode;
};
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));

/**
 * Strict decode of one reply for one request: exactly one entry per rule sent, in the order sent, each echoing that
 * rule's id and revision. Anything else, including a reply for another request, is `malformed`.
 */
function decode(
  reply: unknown,
  expect: { requestId: string; rules: readonly PlainRuleCandidate[] },
  maxReplyBytes: number,
): Entry[] | "malformed" {
  if (typeof reply !== "string" || bytes(reply) > maxReplyBytes) return "malformed";
  let raw: unknown;
  try {
    raw = JSON.parse(reply);
  } catch {
    return "malformed";
  }
  if (!exact(raw, REPLY_KEYS) || raw.schema !== PLAIN_RULE_VERDICT_SCHEMA || raw.requestId !== expect.requestId)
    return "malformed";
  if (!Array.isArray(raw.verdicts) || raw.verdicts.length !== expect.rules.length) return "malformed";
  const entries: Entry[] = [];
  for (const [i, item] of (raw.verdicts as unknown[]).entries()) {
    if (!exact(item, ENTRY_KEYS) || !ENTRY_KEYS.every((k) => typeof item[k] === "string")) return "malformed";
    const rule = expect.rules[i]!;
    if (item.ruleId !== rule.ruleId || item.ruleRevision !== rule.ruleRevision) return "malformed";
    if (!JUDGE_VERDICTS.has(item.verdict as string) || !reasonFits(item.verdict as string, item.reasonCode as string))
      return "malformed";
    entries.push(item as Entry);
  }
  // Reject duplicate keys, reordered fields and alternate encodings: the reply must be the canonical form.
  const canonical = JSON.stringify({
    schema: PLAIN_RULE_VERDICT_SCHEMA,
    requestId: expect.requestId,
    verdicts: entries.map((e) => Object.fromEntries(ENTRY_KEYS.map((k) => [k, e[k]]))),
  });
  return reply === canonical ? entries : "malformed";
}

/** A `judgePermission` over one transport. Its limits and transport are captured now; later mutation is ignored. */
export function createPlainRuleJudge(options: {
  readonly transport: PlainRuleTransport;
  readonly limits?: PlainRuleJudgeLimits;
}): JudgePermission {
  const limits: PlainRuleJudgeLimits = Object.freeze({ ...(options.limits ?? DEFAULT_PLAIN_RULE_LIMITS) });
  const send = options.transport.send;
  const version = options.transport.version;
  const usable = typeof send === "function" && text(version) && validLimits(limits);
  const judgeConfigRef = plainRuleJudgeConfigRef(text(version) ? version : "invalid", limits);
  let inFlight = 0;
  let calls = 0;

  const result = (verdict: PlainRuleVerdict): PlainRuleJudgeOutcome =>
    Object.freeze({ outcome: "no-match", verdict, verdicts: Object.freeze([]), judgeConfigRef });
  /** The earliest covered rule allows, as judging the rules one by one in order would. */
  const decided = (entries: Entry[]): PlainRuleJudgeOutcome => {
    const verdicts = Object.freeze(
      entries.map((e) => Object.freeze({ ruleId: e.ruleId, verdict: e.verdict, reasonCode: e.reasonCode })),
    );
    const winner = entries.find((e) => e.verdict === "covered");
    if (winner)
      return Object.freeze({
        outcome: "allow",
        verdict: "covered",
        ruleId: winner.ruleId,
        ruleRevision: winner.ruleRevision,
        reasonCode: winner.reasonCode,
        verdicts,
        judgeConfigRef,
      });
    const unsure = entries.find((e) => e.verdict === "unsure");
    return Object.freeze({
      outcome: "no-match",
      verdict: unsure ? "unsure" : "not-covered",
      reasonCode: (unsure ?? entries[0]!).reasonCode,
      verdicts,
      judgeConfigRef,
    });
  };

  return async (input, signal) => {
    try {
      if (!usable) return result("unavailable");
      if (signal.aborted) return result("unavailable");
      const selected = snapshot(input, limits);
      if (selected === null) return result("malformed");
      // Hard boundaries first, in code: a judge is never asked about what it could not allow.
      if (selected.restricted) return result("hard-boundary");
      if (!insideEnvelope(selected)) return result("outside-envelope");
      const command = selected.action.title;
      if (bytes(command) > limits.maxCommandBytes || TRIPWIRES.some((t) => t.test(command)))
        return result("injection-suspected");
      if (inFlight >= limits.maxPending || calls >= limits.maxCalls) return result("over-budget");
      calls++;
      inFlight++;
      const requestId = randomUUID();
      const frame = JSON.stringify({
        schema: PLAIN_RULE_REQUEST_SCHEMA,
        requestId,
        rules: selected.rules.map((r) => ({ id: r.ruleId, revision: r.ruleRevision, criterion: r.criterion })),
        action: selected.action,
      });
      const controller = new AbortController();
      // The slot stays taken until the send itself settles, however long a transport ignores its abort.
      // A synchronous throw becomes a rejection here, so it releases the slot the same way.
      const sending: Promise<unknown> = (async () => send(frame, controller.signal))();
      const release = () => {
        inFlight--;
      };
      void sending.then(release, release);
      // The caller's wait ends at the deadline or on cancellation, whichever is first, without waiting for the send.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), limits.timeoutMs);
        });
        const cancelled = new Promise<typeof CANCELLED>((resolve) => {
          onAbort = () => resolve(CANCELLED);
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        let reply: unknown;
        try {
          reply = await Promise.race([sending, deadline, cancelled]);
        } catch {
          return result("unavailable");
        }
        // A reply that arrives together with cancellation is dropped.
        if (reply === CANCELLED || signal.aborted) return result("unavailable");
        if (reply === TIMED_OUT) return result("timeout");
        const decoded = decode(reply, { requestId, rules: selected.rules }, limits.maxReplyBytes);
        return decoded === "malformed" ? result("malformed") : decided(decoded);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
        // Tell the transport to stop when the caller stopped waiting first. A settled send ignores it.
        controller.abort();
      }
    } catch {
      return result("unavailable");
    }
  };
}
