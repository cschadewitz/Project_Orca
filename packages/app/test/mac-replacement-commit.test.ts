/** Synthetic readiness inputs only; existing signed/native engine gates remain required. */
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MacReplacementCommit, type MacReplacementCommitPorts } from "../src/main/mac-replacement-commit.js";
import { MacReplacementBootstrap } from "../src/main/mac-replacement-recovery.js";
import type { MacNativeCommitRequest } from "../src/main/mac-native-handoff.js";
import { readMacManifest } from "../src/main/mac-candidate-manifest.js";
import { readFile } from "node:fs/promises";
import type { MacReplacementRecord, MacProtectedPair } from "../src/main/mac-replacement-journal.js";
import { barrier } from "../../daemon/test/runtime-maintenance-fixture.js";
async function fixture() {
  const target = { workspaceId: randomUUID(), instanceId: randomUUID(), epoch: 1 },
    previousTarget = { workspaceId: target.workspaceId, instanceId: target.instanceId, processId: 8100 },
    token = randomUUID();
  const manifest = readMacManifest(
    await readFile(
      new URL(
        "../../../tools/deploy/tests/native-mac/fixtures/valid/delivery/native-mac-artifact.json",
        import.meta.url,
      ),
    ),
  );
  const candidate = {
    manifestSha256: "b".repeat(64),
    channel: "test",
    compatibilityPlanId: "test",
    recoveryPlanId: "test",
  };
  const request: MacNativeCommitRequest = {
    prepared: {
      scope: "preparation-only",
      directory: "/synthetic",
      target,
      binding: { manifest, candidate, source: "https://delivery.invalid/" },
    },
    lease: {
      target,
      token,
      release: vi.fn(async () => "released" as const),
      stopOwned: vi.fn(async () => ({ outcome: "stopped" as const, receipt: { target: previousTarget } })),
    },
  };
  const pair: MacProtectedPair = {
    id: randomUUID(),
    manifestSha256: "a".repeat(64),
    binarySha256: "c".repeat(64),
    stateSha256: "d".repeat(64),
    roots: [{ id: "complete-test-root", sha256: "e".repeat(64) }],
    continuitySha256: "f".repeat(64),
    writerEpoch: randomUUID(),
    writeRevision: 0,
  };
  const order: string[] = [];
  let record: MacReplacementRecord | undefined;
  const authorization = { token, previousTarget, previousManifestSha256: pair.manifestSha256 };
  const ports: MacReplacementCommitPorts = {
    authorize: vi.fn(async () => authorization),
    acquireWriters: vi.fn(async () => ({
      rootIds: ["complete-test-root"],
      check: () => true,
      stopped: () => true,
      capture: async () => pair,
      verify: async () => true,
      current: async () => pair,
      restorePair: async () => "unknown" as const,
    })),
    journal: {
      read: async () => record,
      commit: vi.fn(async (value) => {
        order.push("durable");
        record = value;
      }),
    },
    replacement: {
      closeBootstrap: vi.fn(async () => {
        order.push("closed");
        return "closed" as const;
      }),
      verifyClosed: async () => ({ outcome: "unknown" }),
    },
  };
  return { request, ports, order, authorization, record: () => record };
}
it("leaves native activation disabled when accepted signed-engine/complete-state ownership is absent", async () => {
  const f = await fixture();
  expect(await new MacReplacementCommit().prepare(f.request)).toBe("refused");
  vi.mocked(f.ports.authorize).mockResolvedValue(undefined);
  expect(await new MacReplacementCommit(f.ports, 5000).prepare(f.request)).toBe("refused");
  expect(f.request.lease.stopOwned).not.toHaveBeenCalled();
  expect(f.ports.acquireWriters).not.toHaveBeenCalled();
});
it("returns native readiness only after clean stop and a durable closed complete-pair record", async () => {
  const f = await fixture(),
    commit = new MacReplacementCommit(f.ports, 5000);
  expect(await commit.prepare(f.request)).toBe("ready");
  expect(f.order).toEqual(["durable", "closed"]);
  expect(f.record()!.token).toBe(f.authorization.token);
  expect(f.record()!.candidate).toEqual(f.request.prepared.binding.candidate);
  expect(await commit.prepare(f.request)).toBe("ready");
  expect(f.request.lease.stopOwned).toHaveBeenCalledOnce();
  expect(
    await commit.prepare({
      ...f.request,
      prepared: { ...f.request.prepared, target: { ...f.request.prepared.target, epoch: 2 } },
    }),
  ).toBe("unknown");
});
it("refuses foreign token and retains unknown on clean-stop or durable-bootstrap loss", async () => {
  const f = await fixture();
  Object.assign(f.request.lease, { token: randomUUID() });
  expect(await new MacReplacementCommit(f.ports, 5000).prepare(f.request)).toBe("unknown");
  expect(f.request.lease.stopOwned).not.toHaveBeenCalled();
  Object.assign(f.request.lease, { token: f.authorization.token });
  vi.mocked(f.request.lease.stopOwned!).mockResolvedValue({ outcome: "unknown" });
  expect(await new MacReplacementCommit(f.ports, 5000).prepare(f.request)).toBe("unknown");
  expect(f.ports.journal.commit).not.toHaveBeenCalled();
});
it("rechecks revocation after durable capture before authorizing native staging", async () => {
  const f = await fixture();
  vi.mocked(f.ports.authorize)
    .mockResolvedValueOnce(f.authorization)
    .mockResolvedValueOnce(f.authorization)
    .mockResolvedValueOnce(f.authorization)
    .mockResolvedValueOnce(undefined);
  expect(await new MacReplacementCommit(f.ports, 5000).prepare(f.request)).toBe("unknown");
  expect(f.record()!.phase).toBe("closed");
  expect(f.request.lease.release).not.toHaveBeenCalled();
});
it("bootstrap closes normal startup synchronously and keeps replacement/uncertain journals closed across repeated reads", async () => {
  const f = await fixture();
  await new MacReplacementCommit(f.ports, 5000).prepare(f.request);
  const bootstrap = new MacReplacementBootstrap(f.ports.journal);
  expect(bootstrap.ordinaryAllowed).toBe(false);
  expect(await bootstrap.inspect()).toMatchObject({ outcome: "replacement-closed" });
  expect(bootstrap.ordinaryAllowed).toBe(false);
  const broken = new MacReplacementBootstrap({
    read: async () => {
      throw new Error("Lost wrapped key");
    },
  });
  expect(await broken.inspect()).toEqual({ outcome: "unknown" });
  expect(broken.ordinaryAllowed).toBe(false);
  const empty = new MacReplacementBootstrap({ read: async () => undefined });
  expect(empty.ordinaryAllowed).toBe(false);
  expect(await empty.inspect()).toEqual({ outcome: "ordinary" });
  expect(empty.ordinaryAllowed).toBe(true);
});
it("bootstrap ignores a late empty-journal response after its bounded observation is lost", async () => {
  vi.useFakeTimers();
  const finish = barrier();
  try {
    const bootstrap = new MacReplacementBootstrap({
      read: async () => {
        await finish.promise;
        return undefined;
      },
    });
    const operation = bootstrap.inspect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await operation).toEqual({ outcome: "unknown" });
    finish.release();
    await Promise.resolve();
    expect(bootstrap.ordinaryAllowed).toBe(false);
  } finally {
    finish.release();
    vi.useRealTimers();
  }
});
