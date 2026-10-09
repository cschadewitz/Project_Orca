/** Main-only adapter to #568. No authentication fallback, recapture, timer or forced stop. */
import {
  RuntimeDrainResultSchema,
  RuntimeMaintenanceResultSchema,
  RuntimeMaintenanceTargetSchema,
} from "@orca/protocol";
import type { z } from "zod";
type RuntimeMaintenanceTarget = z.infer<typeof RuntimeMaintenanceTargetSchema>;
import { macAbortable, macBounded } from "./mac-candidate-download.js";
import type { MacOwnedStopResult } from "./mac-update-restart.js";
import type { MacAdmissionLease, MacDrainLease, MacPreparation, MacUpdateTarget } from "./mac-updates.js";

/** Integration owner supplies the exact authenticated Workspace reservation. Capture fences
 * switching/first-run ownership only; existing answers/continuations/receipts remain usable.
 * freeze switches to the final all-call boundary only after verified held drain proof.
 */
export interface MacDrainOwner {
  readonly target: Readonly<MacUpdateTarget>;
  readonly runtimeTarget: Readonly<RuntimeMaintenanceTarget>;
  check(this: void): boolean;
  release(this: void): void;
  freeze(this: void): boolean;
  runtime(
    this: void,
    action: "drain" | "defer" | "prepare" | "resume",
    token: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  stopOwned?(this: void, signal: AbortSignal, operationMs: number, token: string): Promise<MacOwnedStopResult>;
}
export type CaptureMacDrain = (target: MacUpdateTarget) => Promise<MacDrainOwner | undefined>;
interface Held {
  readonly owner: MacDrainOwner;
  readonly token: string;
  phase: "reserved" | "draining" | "held" | "prepared" | "stopping" | "released" | "unknown";
  operation?: Promise<"draining" | "held" | "unknown"> | undefined;
  releasing: boolean;
}
const owners = new WeakMap<MacDrainLease, Held>();
const same = (a: MacUpdateTarget, b: MacUpdateTarget) =>
  a.workspaceId === b.workspaceId && a.instanceId === b.instanceId && a.epoch === b.epoch;
function runtimeMatches(value: RuntimeMaintenanceTarget, held: Held): boolean {
  const expected = held.owner.runtimeTarget;
  return (
    value.workspaceId === expected.workspaceId &&
    value.instanceId === expected.instanceId &&
    value.processId === expected.processId
  );
}
const unknown = (held: Held): "unknown" => {
  held.phase = "unknown";
  return "unknown";
};

function boundedRead<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return macBounded(new AbortController().signal, 5000, (signal) => macAbortable(() => operation(signal), signal));
}

export async function captureMacDrain(
  capture: CaptureMacDrain | undefined,
  target: MacUpdateTarget,
  token: string,
): Promise<MacPreparation<MacDrainLease>> {
  if (!capture) return { outcome: "blocked", blocker: "activity" };
  let captured: MacDrainOwner | undefined;
  try {
    captured = await boundedRead(() => capture(target));
    if (!captured) return { outcome: "blocked", blocker: "identity" };
    const runtimeTarget = Object.freeze(RuntimeMaintenanceTargetSchema.parse(captured.runtimeTarget));
    if (
      !same(captured.target, target) ||
      runtimeTarget.workspaceId !== target.workspaceId ||
      runtimeTarget.instanceId !== target.instanceId ||
      !captured.check()
    )
      throw new Error("Owner changed");
    const owner: MacDrainOwner = Object.freeze({
      target: Object.freeze({ ...target }),
      runtimeTarget,
      check: captured.check,
      release: captured.release,
      freeze: captured.freeze,
      runtime: captured.runtime,
      ...(captured.stopOwned ? { stopOwned: captured.stopOwned } : {}),
    });
    const held: Held = { owner, token, phase: "reserved", releasing: false };
    const lease: MacDrainLease = Object.freeze({
      target: owner.target,
      token,
      observe: () => {
        if (held.operation) return held.operation;
        if (held.releasing || ["unknown", "released", "stopping"].includes(held.phase))
          return Promise.resolve("unknown" as const);
        held.operation = Promise.resolve()
          .then(async (): Promise<"draining" | "held" | "unknown"> => {
            try {
              if (!owner.check()) return unknown(held);
              const result = RuntimeDrainResultSchema.parse(
                await boundedRead((signal) => owner.runtime("drain", token, signal)),
              );
              if (!owner.check() || !runtimeMatches(result.target, held)) return unknown(held);
              if (result.outcome !== "draining" && result.outcome !== "held") return unknown(held);
              if ((held.phase === "held" || held.phase === "prepared") && result.outcome !== "held")
                return unknown(held);
              if (held.phase !== "prepared") held.phase = result.outcome;
              return result.outcome;
            } catch {
              return unknown(held);
            }
          })
          .finally(() => {
            held.operation = undefined;
          });
        return held.operation;
      },
      release: async () => {
        if (
          held.operation ||
          held.releasing ||
          !owner.check() ||
          ["unknown", "stopping", "released"].includes(held.phase)
        )
          return "unknown";
        held.releasing = true;
        try {
          if (held.phase !== "reserved") {
            const draining = held.phase === "draining";
            const result = (draining ? RuntimeDrainResultSchema : RuntimeMaintenanceResultSchema).parse(
              await owner.runtime(draining ? "defer" : "resume", token),
            );
            if (result.outcome !== "released" || !runtimeMatches(result.target, held) || !owner.check())
              return unknown(held);
          }
          owner.release();
          held.phase = "released";
          return "released";
        } catch {
          return unknown(held);
        }
      },
    });
    owners.set(lease, held);
    return { outcome: "ready", lease };
  } catch {
    // No drain RPC has run yet; failed capture can release only its local reservation.
    if (!captured) return { outcome: "unknown" };
    try {
      captured.release();
    } catch {
      return { outcome: "unknown" };
    }
    return { outcome: "blocked", blocker: "identity" };
  }
}

/** Consume the same held drain owner; no resume gap or second Workspace reservation. */
export async function prepareMacDrain(
  drain: MacDrainLease,
  target: MacUpdateTarget,
  token: string,
  draftsValid: () => boolean,
): Promise<MacPreparation<MacAdmissionLease>> {
  const held = owners.get(drain);
  if (!held || held.token !== token || !same(drain.target, target)) return { outcome: "unknown" };
  try {
    if (
      held.phase !== "held" ||
      held.operation ||
      held.releasing ||
      !held.owner.check() ||
      !draftsValid() ||
      !held.owner.freeze()
    )
      return { outcome: "unknown" };
    const result = RuntimeMaintenanceResultSchema.parse(
      await boundedRead((signal) => held.owner.runtime("prepare", token, signal)),
    );
    if (result.outcome !== "held" || !runtimeMatches(result.target, held) || !held.owner.check() || !draftsValid()) {
      unknown(held);
      return { outcome: "unknown" };
    }
    held.phase = "prepared";
    return {
      outcome: "ready",
      lease: Object.freeze({
        target: drain.target,
        token,
        release: drain.release,
        stopOwned: (signal: AbortSignal, operationMs: number) => {
          if (held.phase !== "prepared" || !held.owner.check() || !draftsValid() || !held.owner.stopOwned)
            return Promise.resolve({ outcome: "unknown" as const });
          held.phase = "stopping";
          return held.owner.stopOwned(signal, operationMs, token);
        },
      }),
    };
  } catch {
    unknown(held);
    return { outcome: "unknown" };
  }
}
