/** Managed composition and held authority over the real authenticated Workspace fixture. */
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createManagedMacUpdateApplication } from "../src/main/mac-managed-update-application.js";
import { macUpdateRehearsal } from "./mac-update-rehearsal-fixture.js";
import type { ManagedMacUpdateAuthority } from "../src/main/mac-managed-update-application.js";
import type { AutoUpdater } from "electron";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function fixture(policy: boolean, allowed: boolean) {
  const f = await macUpdateRehearsal();
  closers.push(() => f.close());
  f.workspace.observeHello(f.workspace.client, await f.workspace.client.hello("managed-owner-facts", false));
  const native = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  });
  const authority: ManagedMacUpdateAuthority = {
    download: {
      root: "/unused-held-download-root",
      limits: { fileBytes: 100_000, totalBytes: 1_000_000, operationMs: 5000 },
      trust: { catalog: f.catalog, inspect: f.inspect },
      fetch: f.downloadFetch,
    },
    binaryRoot: "/unused-held-binary",
    previousManifestSha256: "a".repeat(64),
    verifyBinary: vi.fn(async () => false),
    continuity: vi.fn(async () => {
      throw new Error("Held");
    }),
    startClosed: vi.fn(async () => undefined),
  };
  const pause = vi.fn(async () => false);
  const owner = createManagedMacUpdateApplication({
    control: "/unused-held-control",
    workspace: f.workspace,
    guards: f.guards,
    ...(policy ? { authority } : {}),
    native: () => native as unknown as AutoUpdater,
    activationAllowed: () => allowed,
    pauseAppWriters: pause,
  });
  return { f, native, authority, pause, owner };
}

it.each([
  [false, true],
  [true, false],
])("requires approved authority %s and an open activation gate %s before any operation", async (policy, allowed) => {
  const h = await fixture(policy, allowed),
    signal = new AbortController().signal;
  expect(h.owner.application.state).toEqual({ phase: "unavailable" });
  expect(
    await h.owner.offer(
      { ...h.f.binding.candidate, source: h.f.binding.source, manifestBytes: h.f.bytes },
      h.f.target,
      signal,
    ),
  ).toEqual({ outcome: "refused" });
  expect(await h.owner.captureClosedRecovery(signal)).toBe("unknown");
  expect(await h.owner.verifyClosed(signal)).toEqual({ outcome: "refused", reason: "ownership" });
  await expect(h.owner.restoreClosed(h.f.binding.candidate.manifestSha256, signal)).rejects.toThrow("unavailable");
  expect(h.f.catalog).not.toHaveBeenCalled();
  expect(h.f.downloadFetch).not.toHaveBeenCalled();
  expect(h.authority.verifyBinary).not.toHaveBeenCalled();
  expect(h.authority.continuity).not.toHaveBeenCalled();
  expect(h.authority.startClosed).not.toHaveBeenCalled();
  expect(h.pause).not.toHaveBeenCalled();
  expect(h.native.setFeedURL).not.toHaveBeenCalled();
  expect(h.native.checkForUpdates).not.toHaveBeenCalled();
  expect(h.native.quitAndInstall).not.toHaveBeenCalled();
});

it("captures only the current authenticated managed owner and retains it through its update reservation", async () => {
  const h = await fixture(false, false);
  const facts = h.f.workspace.captureMacUpdateOwnerFacts(h.f.target);
  expect(facts?.check()).toBe(true);
  expect(facts?.storeDir).toBe(facts!.configDir + "/.orca");
  expect(facts?.previousTarget).toMatchObject({
    workspaceId: h.f.target.workspaceId,
    instanceId: h.f.target.instanceId,
  });
  expect(h.f.workspace.captureMacUpdateOwnerFacts({ ...h.f.target, epoch: h.f.target.epoch + 1 })).toBeUndefined();
  const reserved = await h.f.workspace.captureMacUpdateDrainTarget(h.f.target);
  expect(reserved?.check()).toBe(true);
  expect(facts?.check()).toBe(true);
  reserved?.release();
  await h.f.workspace.close();
  expect(facts?.check()).toBe(false);
});
