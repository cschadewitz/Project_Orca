/** Explicit recovery holds the same kernel fence throughout verification and durable settlement. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  acquireFirstRunFence,
  observeFirstRunFence,
  WriterSchema,
  fenceBoot,
  assertFenceVolume,
  FenceBootSchema,
} from "@orca/protocol/first-run-fence";
import {
  absent,
  directory,
  hash,
  inspectFirstRunOwnership,
  read,
  recoveryEvidenceHash,
  recoveryRequestSchema,
  sameDirectory,
  write,
  refuse,
} from "./ownership.js";

export class FirstRunRecovery {
  constructor(private readonly path: string) {}
  prepare(assertCurrent: () => void) {
    const snapshot = inspectFirstRunOwnership(this.path, true);
    const latest = snapshot.latest;
    if (!latest || latest.settled) return refuse();
    const claim = JSON.parse(latest.texts["claim.json"]!) as { version: number; store: unknown };
    if (claim.version !== 2) return refuse(); // No retrospective proof for an unfenced legacy writer.
    const existing = latest.texts["recovery-request.json"];
    if (existing)
      return { state: "ready" as const, requestId: recoveryRequestSchema.parse(JSON.parse(existing)).requestId };
    const writerText = latest.texts["writer.json"];
    const writer = writerText ? WriterSchema.parse(JSON.parse(writerText)) : undefined;
    const store = absent(join(this.path, ".orca")) ? null : directory(join(this.path, ".orca"), snapshot.workspace);
    if (
      writer
        ? !store || !sameDirectory(writer.store, store)
        : JSON.stringify(store) !== JSON.stringify(claim.store) || !!latest.texts["child.json"]
    )
      return refuse();
    const request = recoveryRequestSchema.parse({
      version: 2,
      requestId: randomUUID(),
      reservationId: latest.reservationId,
      anchorHash: hash(snapshot.anchorText),
      evidenceHash: recoveryEvidenceHash(latest.texts),
      configHash: snapshot.configHash,
      store,
      writerHash: writerText ? hash(writerText) : null,
      authority: "explicit-same-boot-fence",
    });
    assertCurrent();
    write(join(latest.attempt.path, "recovery-request.json"), JSON.stringify(request) + "\n", latest.attempt);
    return { state: "ready" as const, requestId: request.requestId };
  }
  async reconcile(requestId: string, assertCurrent: () => void) {
    const snapshot = inspectFirstRunOwnership(this.path, true);
    const latest = snapshot.latest;
    if (!latest?.texts["recovery-request.json"]) return refuse();
    const request = recoveryRequestSchema.parse(JSON.parse(latest.texts["recovery-request.json"]));
    if (request.requestId !== requestId) return refuse();
    assertFenceVolume(this.path);
    const writer = latest.texts["writer.json"]
      ? WriterSchema.parse(JSON.parse(latest.texts["writer.json"]))
      : undefined;
    const boot = fenceBoot();
    const claim = JSON.parse(latest.texts["claim.json"]!) as { boot: unknown };
    if (JSON.stringify(FenceBootSchema.parse(claim.boot)) !== JSON.stringify(boot)) return refuse();
    if (
      writer &&
      (writer.bootId !== boot.bootId || writer.hostHash !== boot.hostHash || writer.kernelDomain !== boot.kernelDomain)
    )
      return refuse();
    if (latest.settled) {
      const store = absent(join(this.path, ".orca")) ? null : directory(join(this.path, ".orca"), snapshot.workspace);
      if (JSON.stringify(store) !== JSON.stringify(request.store)) return refuse();
      assertCurrent();
      return { state: "reconciled" as const, requestId };
    }
    let fence;
    try {
      fence = await acquireFirstRunFence(snapshot.workspace, () => undefined);
    } catch {
      const observed = await observeFirstRunFence(snapshot.workspace);
      assertCurrent();
      return {
        state:
          writer && observed === hash(JSON.stringify(writer))
            ? ("surviving-owned-daemon" as const)
            : ("unknown-writer" as const),
        requestId,
      };
    }
    try {
      assertCurrent();
      // Holding the kernel handle is the positive proof; no PID query or signalling is involved.
      const fresh = inspectFirstRunOwnership(this.path, true);
      const store = absent(join(this.path, ".orca")) ? null : directory(join(this.path, ".orca"), fresh.workspace);
      if (
        JSON.stringify(fresh) !== JSON.stringify(snapshot) ||
        JSON.stringify(store) !== JSON.stringify(request.store) ||
        JSON.stringify(fenceBoot()) !== JSON.stringify(boot)
      )
        return refuse();
      assertCurrent();
      write(
        join(latest.attempt.path, "recovery.json"),
        JSON.stringify({
          requestHash: hash(read(join(latest.attempt.path, "recovery-request.json"), latest.attempt)),
          reservationId: latest.reservationId,
          writerHash: request.writerHash,
          store,
          observation: "exclusive-writer-quiescent",
        }) + "\n",
        latest.attempt,
      );
      inspectFirstRunOwnership(this.path);
      return { state: "reconciled" as const, requestId };
    } finally {
      await new Promise<void>((resolve) => fence.close(() => resolve()));
    }
  }
}

/** Explicit offline binding after Save/app loss. A held fence replaces lost live config-read authority. */
export async function bindQuiescentConfiguration(
  path: string,
  expectedHash: string,
  savedHash: string,
  assertCurrent: () => void,
) {
  const snapshot = inspectFirstRunOwnership(path, true, true);
  const latest = snapshot.latest;
  if (!latest || latest.texts["recovery-request.json"] || snapshot.configHash !== savedHash) return refuse();
  const claim = JSON.parse(latest.texts["claim.json"]!) as { version: number; configHash: string; store: unknown };
  if (claim.version !== 2) return refuse();
  const writer = latest.texts["writer.json"] ? WriterSchema.parse(JSON.parse(latest.texts["writer.json"])) : undefined;
  const boot = fenceBoot();
  const claimBoot = (JSON.parse(latest.texts["claim.json"]!) as { boot: unknown }).boot;
  if (JSON.stringify(FenceBootSchema.parse(claimBoot)) !== JSON.stringify(boot)) return refuse();
  assertFenceVolume(path);
  if (
    writer &&
    (writer.bootId !== boot.bootId ||
      writer.hostHash !== boot.hostHash ||
      writer.kernelDomain !== boot.kernelDomain ||
      !sameDirectory(writer.store, directory(join(path, ".orca"), snapshot.workspace)))
  )
    return refuse();
  const currentStore = absent(join(path, ".orca")) ? null : directory(join(path, ".orca"), snapshot.workspace);
  if (!writer && (JSON.stringify(currentStore) !== JSON.stringify(claim.store) || latest.texts["child.json"]))
    return refuse();
  let fence;
  try {
    fence = await acquireFirstRunFence(snapshot.workspace, () => undefined);
  } catch {
    return refuse();
  }
  try {
    assertCurrent();
    if (JSON.stringify(inspectFirstRunOwnership(path, true, true)) !== JSON.stringify(snapshot)) return refuse();
    // Idempotently publish a receipt after a prior successful journal append was interrupted.
    if (snapshot.effectiveHash === savedHash) return;
    if (snapshot.effectiveHash !== expectedHash || latest.settled) return refuse();
    const count = Object.keys(latest.texts).filter((name) => name.startsWith("config-rebind-")).length;
    if (count >= 32) return refuse();
    write(
      join(latest.attempt.path, `config-rebind-${String(count + 1).padStart(6, "0")}.json`),
      JSON.stringify({
        reservationId: latest.reservationId,
        previousHash: expectedHash,
        savedHash,
        authority: "reviewed-quiescent-config",
      }) + "\n",
      latest.attempt,
    );
    inspectFirstRunOwnership(path, true);
  } finally {
    await new Promise<void>((resolve) => fence.close(() => resolve()));
  }
}
