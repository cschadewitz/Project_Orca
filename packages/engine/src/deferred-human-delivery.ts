/** Ephemeral pre-approval intent binding. No JSON restoration, execution permit or provider resume. */
import { isDeepStrictEqual } from "node:util";
import type { ActionEvidenceV1, MutationActor } from "@orca/core";
import type { HumanInputQuery } from "./human-input.js";
import {
  assertOriginalDelivery,
  bindOriginalDelivery,
  readOriginalDelivery,
  type LiveOriginalDelivery,
} from "./live-input.js";

declare const deferredBrand: unique symbol;
export interface DeferredHumanDelivery {
  readonly [deferredBrand]: true;
}
interface Retained {
  delivery: LiveOriginalDelivery;
  query: HumanInputQuery;
  actor: MutationActor;
  onceOptionId: string;
  scope: object;
  bytes: string;
  invocation: ActionEvidenceV1["invocation"];
  authority: ActionEvidenceV1["authority"];
  action?: ActionEvidenceV1;
}
const retained = new WeakMap<DeferredHumanDelivery, Retained>();
const reservations = new WeakSet<LiveOriginalDelivery>();
const refuse = (): never => {
  throw new Error("Deferred original delivery unavailable");
};

/** Called by the closed service before answering, with canonical bytes and a private
 * intent scope. The real registry enforces original-query identity and pending state. */
export function reserveDeferredHumanDelivery(input: Omit<Retained, "action">): DeferredHumanDelivery {
  if (
    reservations.has(input.delivery) ||
    !input.bytes ||
    Buffer.byteLength(input.bytes, "utf8") > 32768 ||
    !input.onceOptionId ||
    input.actor.principalId !== input.invocation.principalRef ||
    input.query.runId !== input.invocation.runId ||
    input.query.stepRunId !== input.invocation.stepRunId ||
    (["instanceId", "sessionId", "turnId", "invocationId"] as const).some(
      (key) => input.query.live?.identity[key] !== input.invocation[key],
    )
  )
    refuse();
  bindOriginalDelivery(input.delivery, input.query, input.scope);
  const token = Object.freeze({}) as DeferredHumanDelivery;
  retained.set(token, {
    ...input,
    actor: structuredClone(input.actor),
    invocation: structuredClone(input.invocation),
    authority: structuredClone(input.authority),
  });
  reservations.add(input.delivery);
  return token;
}

/** Waits for final successful owned acknowledgement, not just callback resolution. */
export async function readDeferredHumanDelivery(token: DeferredHumanDelivery) {
  const value = retained.get(token) ?? refuse();
  return readOriginalDelivery(value.delivery, value.query, value.actor, value.onceOptionId);
}

/** Release the owning wait on cancellation; late settlement never resumes it. */
export function awaitDeferred<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error("Deferred original delivery cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error instanceof Error ? error : new Error("Deferred original delivery failed"));
      },
    );
    if (signal.aborted) cancel();
  });
}

/** The only post-answer attachment. Exact original intent; no normal binder relaxation. */
export function attachDeferredHumanDelivery(
  token: DeferredHumanDelivery,
  delivery: LiveOriginalDelivery,
  query: HumanInputQuery,
  actor: MutationActor,
  onceOptionId: string,
  scope: object,
  action: ActionEvidenceV1,
  bytes: string,
): undefined {
  const value = retained.get(token) ?? refuse();
  if (
    value.delivery !== delivery ||
    value.query !== query ||
    value.scope !== scope ||
    value.onceOptionId !== onceOptionId ||
    value.bytes !== bytes ||
    !isDeepStrictEqual(value.actor, actor) ||
    !isDeepStrictEqual(value.invocation, action.invocation) ||
    !isDeepStrictEqual(value.authority, {
      ...action.authority,
      currentPolicyRevision: value.authority.currentPolicyRevision,
    }) ||
    (value.action && value.action !== action)
  )
    refuse();
  assertOriginalDelivery(delivery, query);
  value.action = action;
  return undefined;
}
