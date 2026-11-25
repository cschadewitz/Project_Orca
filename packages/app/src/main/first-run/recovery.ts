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
  firstRunLayout,
} from "@orca/protocol/first-run-fence";
import {
  absent,
  directory,
  FirstRunOwnershipRefusal,
  hash,
  inspectFirstRunOwnership,
  read,
  REBOOT_SETTLEMENT,
  rebootEvidenceHash,
  rebootSettlementSchema,
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
    const store = absent(firstRunLayout(this.path).store)
      ? null
      : directory(firstRunLayout(this.path).store, snapshot.workspace);
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
      const store = absent(firstRunLayout(this.path).store)
        ? null
        : directory(firstRunLayout(this.path).store, snapshot.workspace);
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
      const store = absent(firstRunLayout(this.path).store)
        ? null
        : directory(firstRunLayout(this.path).store, fresh.workspace);
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

const PREVIOUS_SESSION_REFUSAL =
  "The previous session was not marked ended. A live process may still hold this workspace's startup fence, or its ownership evidence changed after it was shown. Nothing was changed. Close other app windows and daemons for this workspace, read setup again, then retry.";

/** The latest attempt when it is unsettled and was claimed on an earlier boot of this host. Same-boot recovery
 * cannot settle it, because its fence and writer belonged to that boot. Reading this never settles anything. */
export function previousBootAttempt(path: string) {
  const snapshot = inspectFirstRunOwnership(path, true);
  const latest = snapshot.latest;
  if (!latest || latest.settled) return undefined;
  const claim = JSON.parse(latest.texts["claim.json"]!) as { version: number; boot?: unknown; store?: unknown };
  // A legacy claim recorded no boot, so nothing shows it predates this one.
  if (claim.version !== 2) return undefined;
  const recorded = FenceBootSchema.parse(claim.boot);
  const boot = fenceBoot();
  if (recorded.hostHash !== boot.hostHash || recorded.bootId === boot.bootId) return undefined;
  return { snapshot, latest, claim: { store: claim.store }, boot };
}

/** A person's explicit confirmation, after a restart, that the previous session ended (owner decision 2026-10-14).
 * Never automatic and never a restart prerequisite. Under the same kernel fence as same-boot recovery it rechecks
 * that the attempt is still unsettled and from an earlier boot, that nothing holds the fence, and the same store
 * evidence, then appends the settlement. Any failed check refuses and writes nothing. */
export async function endPreviousBootSession(path: string, reservationId: string, assertCurrent: () => void) {
  const refused = (cause?: unknown): never => {
    throw new FirstRunOwnershipRefusal(cause, PREVIOUS_SESSION_REFUSAL);
  };
  let found;
  try {
    found = previousBootAttempt(path);
  } catch (error) {
    return refused(error);
  }
  if (!found || found.latest.reservationId !== reservationId) return refused();
  const { snapshot, latest, claim, boot } = found;
  const writer = latest.texts["writer.json"] ? WriterSchema.parse(JSON.parse(latest.texts["writer.json"])) : undefined;
  // The store rules of same-boot recovery: the attested writer's store, or the claim's store with no child.
  const store = () => {
    const current = absent(firstRunLayout(path).store)
      ? null
      : directory(firstRunLayout(path).store, snapshot.workspace);
    if (
      writer
        ? !current || !sameDirectory(writer.store, current)
        : JSON.stringify(current) !== JSON.stringify(claim.store) || !!latest.texts["child.json"]
    )
      return refused();
    return current;
  };
  try {
    assertFenceVolume(path);
    store();
  } catch (error) {
    return refused(error);
  }
  let fence;
  try {
    fence = await acquireFirstRunFence(snapshot.workspace, () => undefined);
  } catch (error) {
    // Something live on this boot holds it. Never adopt, probe or signal it.
    return refused(error);
  }
  try {
    assertCurrent();
    let current;
    try {
      current = store();
      if (
        JSON.stringify(inspectFirstRunOwnership(path, true)) !== JSON.stringify(snapshot) ||
        JSON.stringify(fenceBoot()) !== JSON.stringify(boot)
      )
        return refused();
    } catch (error) {
      return refused(error);
    }
    assertCurrent();
    write(
      join(latest.attempt.path, REBOOT_SETTLEMENT),
      JSON.stringify(
        rebootSettlementSchema.parse({
          version: 1,
          reservationId: latest.reservationId,
          claimHash: hash(latest.texts["claim.json"]!),
          anchorHash: hash(snapshot.anchorText),
          evidenceHash: rebootEvidenceHash(latest.texts),
          configHash: snapshot.effectiveHash,
          store: current,
          boot,
          reason: "person-confirmed-after-reboot",
          observation: "fence-free-after-reboot",
          actor: { kind: "person", surface: "desktop-app", uid: snapshot.workspace.uid },
        }),
      ) + "\n",
      latest.attempt,
    );
    inspectFirstRunOwnership(path);
    return { state: "ended" as const, reservationId };
  } finally {
    await new Promise<void>((resolve) => fence.close(() => resolve()));
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
      !sameDirectory(writer.store, directory(firstRunLayout(path).store, snapshot.workspace)))
  )
    return refuse();
  const currentStore = absent(firstRunLayout(path).store)
    ? null
    : directory(firstRunLayout(path).store, snapshot.workspace);
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
