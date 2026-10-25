/**
 * #594 OFFLINE REFERENCE ONLY. No production export, transport, process or persistence.
 * Models obligations for a future maintained bridge; metadata is NOT a trust root.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const CONTRACT = "orca.command-evidence/1";
export const ROW_BYTES = 12 * 1024;
export const RESULT_BYTES = 256 * 1024;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Target = Record<
  "runId" | "stepRunId" | "requestId" | "instanceId" | "sessionId" | "turnId" | "invocationId",
  string
>;
export interface Offered {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  nativeDecision: Json;
  scope: "command" | "turn" | "session" | "policy" | "none";
}
export interface Capture {
  contract: string;
  /** Exact, source-reviewed build descriptor. No actual maintained v1 pair exists yet. */
  source: { bridge: string; native: string; semantics: "offline-reference" | "unsupported" };
  target: Target;
  native: {
    /** Opaque original connection and callback closures; never serialized. */
    connection: object;
    callback: object;
    requestId: string | number;
    method: string;
    /** Full original JSON params, before presentation. Missing and null stay distinct. */
    params: { [key: string]: Json };
  };
  acp: { requestId: string | number; sessionId: string; toolCallId: string; offered: Offered[] };
  /** Upstream must attest this from the native emission/negotiation, never field absence. */
  scopeEvidence: "complete" | "missing" | "experimental-stripped";
  representation: "native-shell-quoted" | "unknown";
  lease: object;
  expiresAt: number;
}
export interface Owner {
  signal: AbortSignal;
  now(this: void): number;
  current(this: void): Capture;
  /** Existing interpreter lease/mutation mutex, not a fresh or recovered lease. */
  withOwnership<T>(this: void, operation: () => Promise<T>): Promise<T>;
  /** Current credential, review/answer authority and exact run scope, under ownership. */
  authorize(this: void, operation: "review" | "answer", target: Target): Promise<void>;
  /** Counter-only fixture hooks. Production integration must reuse LiveHumanInput. */
  record(this: void, optionId: string): Promise<void>;
  deliver(this: void, decision: Json): Promise<void>;
}
export type Unavailable = { state: "unavailable" | "incomplete" | "unsupported"; options: [] };
export interface Review {
  state: "complete";
  contract: string;
  reviewId: string;
  target: Target;
  source: Capture["source"];
  native: {
    requestId: string | number;
    method: string;
    threadId: string;
    turnId: string;
    itemId: string;
    approvalId: Json;
    environmentId: string;
    startedAtMs: number;
    command: { representation: "native-shell-quoted"; text: string };
    cwd: string;
    scope: {
      networkApprovalContext: null;
      additionalPermissions: null;
      proposedExecpolicyAmendment: null;
      proposedNetworkPolicyAmendments: null;
    };
  };
  acp: Capture["acp"];
  options: Offered[];
  expiresAt: number;
}

const paramKeys = new Set([
  "kind",
  "threadId",
  "turnId",
  "itemId",
  "startedAtMs",
  "approvalId",
  "environmentId",
  "reason",
  "networkApprovalContext",
  "command",
  "cwd",
  "commandActions",
  "additionalPermissions",
  "proposedExecpolicyAmendment",
  "proposedNetworkPolicyAmendments",
  "availableDecisions",
]);
const scopeKeys = [
  "networkApprovalContext",
  "additionalPermissions",
  "proposedExecpolicyAmendment",
  "proposedNetworkPolicyAmendments",
] as const;
const targetKeys = ["runId", "stepRunId", "requestId", "instanceId", "sessionId", "turnId", "invocationId"] as const;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const requestId = (value: unknown) => nonempty(value) || (typeof value === "number" && Number.isSafeInteger(value));
const unavailable = (state: Unavailable["state"]): Unavailable => ({ state, options: [] });

/** Closed v1 subset: ordinary commands with explicitly complete, absent extra scope. */
function eligibility(capture: Capture): Unavailable["state"] | undefined {
  const n = capture.native;
  const p = n.params;
  const offered = capture.acp.offered;
  if (
    capture.contract !== CONTRACT ||
    capture.source.semantics !== "offline-reference" ||
    !nonempty(capture.source.bridge) ||
    !nonempty(capture.source.native)
  )
    return "unsupported";
  if (
    n.method !== "item/commandExecution/requestApproval" ||
    p.kind !== "command" ||
    capture.representation !== "native-shell-quoted" ||
    Object.keys(p).some((key) => !paramKeys.has(key))
  )
    return "unsupported";
  if (capture.scopeEvidence !== "complete" || !scopeKeys.every((key) => Object.hasOwn(p, key))) return "incomplete";
  if (!scopeKeys.every((key) => p[key] === null)) return "unsupported";
  if (
    !requestId(n.requestId) ||
    !requestId(capture.acp.requestId) ||
    Object.keys(capture.target).length !== targetKeys.length ||
    !targetKeys.every((key) => nonempty(capture.target[key])) ||
    ![p.threadId, p.turnId, p.itemId, p.environmentId, p.command, p.cwd].every(nonempty) ||
    !Object.hasOwn(p, "approvalId") ||
    (p.approvalId !== null && !nonempty(p.approvalId)) ||
    typeof p.startedAtMs !== "number" ||
    !Number.isSafeInteger(p.startedAtMs) ||
    !Number.isSafeInteger(capture.expiresAt)
  )
    return "incomplete";
  if (capture.acp.sessionId !== p.threadId || capture.acp.toolCallId !== p.itemId) return "unsupported";
  if (
    !Array.isArray(p.availableDecisions) ||
    p.availableDecisions.length !== offered.length ||
    !offered.every((option) =>
      (p.availableDecisions as Json[]).some((decision) => isDeepStrictEqual(decision, option.nativeDecision)),
    )
  )
    return "incomplete";
  if (
    new Set(offered.map((option) => option.optionId)).size !== offered.length ||
    new Set(offered.map((option) => JSON.stringify(option.nativeDecision))).size !== offered.length ||
    !offered.every(
      (option) =>
        nonempty(option.optionId) &&
        nonempty(option.name) &&
        ((option.nativeDecision === "accept" && option.kind === "allow_once" && option.scope === "command") ||
          ((option.nativeDecision === "decline" || option.nativeDecision === "cancel") &&
            option.kind === "reject_once" &&
            option.scope === "none")),
    ) ||
    !offered.some((option) => option.nativeDecision === "accept") ||
    !offered.some((option) => option.kind === "reject_once")
  )
    return "unsupported";
  return undefined;
}

function snapshot(capture: Capture) {
  // Opaque identities are kept separately, never cloned into public data.
  const { lease: _lease, native, ...rest } = capture;
  const { connection: _connection, callback: _callback, ...request } = native;
  return structuredClone({ ...rest, native: request });
}

/** Exact JSON/framing budget witness. Caller supplies the complete enclosing result. */
export function fitsReview(row: Review, frame: (row: Review) => Json): boolean {
  return (
    Buffer.byteLength(JSON.stringify(row)) <= ROW_BYTES &&
    Buffer.byteLength(JSON.stringify(frame(structuredClone(row)))) <= RESULT_BYTES
  );
}

export function captureOffline(original: Capture, owner: Owner) {
  const saved = snapshot(original);
  const connection = original.native.connection;
  const callback = original.native.callback;
  const lease = original.lease;
  const reviewId = randomUUID();
  const reason = eligibility(original);
  let state: "pending" | "claimed" | "consumed" | "invalid" = "pending";
  let reviewed = false;
  const unchanged = () => {
    const current = owner.current();
    return (
      !owner.signal.aborted &&
      owner.now() < saved.expiresAt &&
      current.native.connection === connection &&
      current.native.callback === callback &&
      current.lease === lease &&
      isDeepStrictEqual(snapshot(current), saved)
    );
  };
  return {
    /** No disclosure unless the fixture's independent authorization hook succeeds. */
    async review(frame: (row: Review) => Json): Promise<Review | Unavailable> {
      return owner.withOwnership(async () => {
        await owner.authorize("review", structuredClone(saved.target));
        if (state !== "pending" || !unchanged()) return unavailable("unavailable");
        if (reason) return unavailable(reason);
        const p = saved.native.params;
        const row: Review = {
          state: "complete",
          contract: CONTRACT,
          reviewId,
          target: saved.target,
          source: saved.source,
          native: {
            requestId: saved.native.requestId,
            method: saved.native.method,
            threadId: p.threadId as string,
            turnId: p.turnId as string,
            itemId: p.itemId as string,
            approvalId: p.approvalId!,
            environmentId: p.environmentId as string,
            startedAtMs: p.startedAtMs as number,
            command: { representation: "native-shell-quoted", text: p.command as string },
            cwd: p.cwd as string,
            scope: {
              networkApprovalContext: null,
              additionalPermissions: null,
              proposedExecpolicyAmendment: null,
              proposedNetworkPolicyAmendments: null,
            },
          },
          acp: saved.acp,
          options: saved.acp.offered,
          expiresAt: saved.expiresAt,
        };
        if (!fitsReview(row, frame)) return unavailable("incomplete");
        reviewed = true;
        return structuredClone(row);
      });
    },
    async answer(answer: { reviewId: string; target: Target; optionId: string; standing?: boolean }) {
      const option = saved.acp.offered.find((option) => option.optionId === answer.optionId);
      if (
        state !== "pending" ||
        !reviewed ||
        reason ||
        answer.standing ||
        answer.reviewId !== reviewId ||
        !isDeepStrictEqual(answer.target, saved.target) ||
        !option
      )
        throw new Error("EVIDENCE_UNAVAILABLE");
      // Claim before every await; never retry uncertain persistence or delivery.
      state = "claimed";
      let recorded = false;
      try {
        return await owner.withOwnership(async () => {
          await owner.authorize("answer", structuredClone(saved.target));
          if (!unchanged()) throw new Error("EVIDENCE_UNAVAILABLE");
          await owner.record(option.optionId);
          recorded = true;
          if (!unchanged()) return { recorded: true, delivered: false };
          state = "consumed";
          await owner.deliver(structuredClone(option.nativeDecision));
          return { recorded: true, delivered: true };
        });
      } finally {
        // Conservative fixture: even authorization failure retires this review identity.
        // Production retains LiveHumanInput's existing refused-responder semantics.
        state = recorded ? "consumed" : "invalid";
      }
    },
  };
}
