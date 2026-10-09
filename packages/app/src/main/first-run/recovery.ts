/** Explicit recovery preserves all evidence and requires a fenced, same-host full reboot. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  absent,
  directory,
  hash,
  inspectFirstRunOwnership,
  read,
  recoveryEvidenceHash,
  recoveryRequestSchema,
  rebootSchema,
  sameDirectory,
  write,
  refuse,
  type RebootIdentity,
} from "./ownership.js";
import { readRecoveryHost, assertRecoveryLocalVolume } from "./recovery-host.js";
export interface RecoveryAuthority {
  /** Trusted main/OS observation. Renderer-supplied boot/host values are never accepted. */
  host(): RebootIdentity;
  assertLocalVolume(path: string): void;
}
export const systemRecoveryAuthority: RecoveryAuthority = {
  host: readRecoveryHost,
  assertLocalVolume: assertRecoveryLocalVolume,
};
export type RecoveryStatus = { state: "restart-required" | "reconciled"; requestId: string };
export class FirstRunRecovery {
  constructor(
    private readonly path: string,
    private readonly authority: RecoveryAuthority = systemRecoveryAuthority,
  ) {}
  prepare(assertCurrent: () => void): RecoveryStatus {
    const snapshot = inspectFirstRunOwnership(this.path, true);
    const latest = snapshot.latest;
    if (!latest || latest.settled) return refuse();
    assertCurrent();
    this.authority.assertLocalVolume(this.path);
    const reboot = rebootSchema.parse(this.authority.host());
    const store = absent(join(this.path, ".orca")) ? null : directory(join(this.path, ".orca"), snapshot.workspace);
    const existing = latest.texts["recovery-request.json"];
    if (existing) {
      const request = recoveryRequestSchema.parse(JSON.parse(existing));
      if (request.reboot.hostHash !== reboot.hostHash || request.reboot.platform !== reboot.platform) return refuse();
      return { state: "restart-required", requestId: request.requestId };
    }
    const request = recoveryRequestSchema.parse({
      version: 1,
      requestId: randomUUID(),
      reservationId: latest.reservationId,
      anchorHash: hash(snapshot.anchorText),
      evidenceHash: recoveryEvidenceHash(latest.texts),
      configHash: snapshot.configHash,
      store,
      reboot,
      authority: "explicit-machine-restart",
    });
    // Reobserve immediately before exclusive append. A raced/torn append remains a refusal.
    const fresh = inspectFirstRunOwnership(this.path, true);
    if (
      JSON.stringify(fresh) !== JSON.stringify(snapshot) ||
      JSON.stringify(this.authority.host()) !== JSON.stringify(reboot)
    )
      return refuse();
    assertCurrent();
    write(join(latest.attempt.path, "recovery-request.json"), JSON.stringify(request) + "\n", latest.attempt);
    return { state: "restart-required", requestId: request.requestId };
  }
  reconcile(requestId: string, assertCurrent: () => void): RecoveryStatus {
    const snapshot = inspectFirstRunOwnership(this.path, true);
    const latest = snapshot.latest;
    if (!latest?.texts["recovery-request.json"]) return refuse();
    const text = latest.texts["recovery-request.json"];
    const request = recoveryRequestSchema.parse(JSON.parse(text));
    if (request.requestId !== requestId) return refuse();
    this.authority.assertLocalVolume(this.path);
    const reboot = rebootSchema.parse(this.authority.host());
    if (
      reboot.hostHash !== request.reboot.hostHash ||
      reboot.platform !== request.reboot.platform ||
      reboot.bootId === request.reboot.bootId
    )
      return refuse();
    const store = absent(join(this.path, ".orca")) ? null : directory(join(this.path, ".orca"), snapshot.workspace);
    if (
      (store === null) !== (request.store === null) ||
      (store && request.store && !sameDirectory(store, request.store))
    )
      return refuse();
    // A surviving app owner is invalidated by the request; CLI bootstrap also honors it.
    // Both paths remain fenced until a subsequent verified app reservation is created.
    const fresh = inspectFirstRunOwnership(this.path, true);
    if (
      JSON.stringify(fresh) !== JSON.stringify(snapshot) ||
      JSON.stringify(this.authority.host()) !== JSON.stringify(reboot)
    )
      return refuse();
    assertCurrent();
    if (!latest.settled)
      write(
        join(latest.attempt.path, "recovery.json"),
        JSON.stringify({
          requestHash: hash(read(join(latest.attempt.path, "recovery-request.json"), latest.attempt)),
          reservationId: latest.reservationId,
          reboot,
          observation: "same-host-new-boot-fenced",
        }) + "\n",
        latest.attempt,
      );
    inspectFirstRunOwnership(this.path);
    return { state: "reconciled", requestId };
  }
}
