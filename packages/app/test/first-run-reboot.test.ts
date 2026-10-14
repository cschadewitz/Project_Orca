/** Person-confirmed settlement after a restart: offered for an earlier boot only, never automatic, fenced, verifiable. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import { acquireFirstRunFence, fenceDirectory } from "@orca/protocol/first-run-fence";
import { firstRunRequiresExplicitContinuationRecovery } from "../../cli/src/first-run-recovery-fence.js";
import type { DaemonClient } from "../src/client/daemon-client.js";
import {
  OWNERSHIP_DIRECTORY,
  REBOOT_SETTLEMENT,
  inspectFirstRunOwnership,
  reserveFirstRunOwnership,
} from "../src/main/first-run/ownership.js";
import { FirstRunRecovery, endPreviousBootSession } from "../src/main/first-run/recovery.js";
import { FirstRunSetup, type FirstRunDeps } from "../src/main/first-run/setup.js";
import { syntheticFirstRunWriter } from "./fixtures/synthetic-first-run-writer.js";

// A restart, as the fence observes it: the same host, a new boot identity.
const restart = vi.hoisted(() => ({ boot: undefined as { bootId?: string; hostHash?: string } | undefined }));
vi.mock("@orca/protocol/first-run-fence", async (original) => {
  const actual = await original<typeof import("@orca/protocol/first-run-fence")>();
  return { ...actual, fenceBoot: () => ({ ...actual.fenceBoot(), ...restart.boot }) };
});
const restarted = () => {
  restart.boot = { bootId: randomUUID() };
};

const roots: string[] = [];
afterEach(async () => {
  restart.boot = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** A prepared selection whose Connect reserves the way Workspace does, with a synthetic authenticated child. */
async function rig() {
  // Under the checkout: the lifetime fence refuses tmpfs volumes.
  const root = await mkdtemp(join(process.cwd(), ".orca-reboot-test-"));
  roots.push(root);
  const home = join(root, "home"),
    project = join(root, "project"),
    workspace = join(root, "workspace");
  for (const path of [home, project, workspace]) await mkdir(path);
  const run = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
  run("init", "-b", "prepared");
  run("-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "--no-gpg-sign", "-m", "f");
  const hello: HelloResult = {
    protocol: PROTOCOL_VERSION,
    orcaVersion: "fixture",
    capabilities: ["runs.read", "runs.control", "runs.subscribe"],
    identity: { workspaceId: randomUUID(), instanceId: randomUUID() },
    storeDir: join(workspace, ".orca"),
    processId: 123,
  };
  const client = {
    hello: vi.fn().mockResolvedValue(hello),
    call: vi.fn().mockResolvedValue({
      target: hello.identity,
      authentication: "credential",
      operations: ["operator.admitRun"],
    }),
    withCapturedAuthentication: () => client,
  };
  const activate = vi.fn();
  const deps: FirstRunDeps = {
    home,
    receiptPath: join(root, "profile", "selection.json"),
    choose: vi.fn<FirstRunDeps["choose"]>().mockResolvedValueOnce(project).mockResolvedValueOnce(workspace),
    current: () => false,
    prepareConnection: vi.fn(async (path: string) => {
      reserveFirstRunOwnership(path);
      return { client: client as unknown as DaemonClient, expectedProcessId: 123, activate, dispose: async () => {} };
    }),
  };
  const setup = new FirstRunSetup(deps);
  const selected = await setup.choose(() => {});
  if (selected.state !== "review") throw new Error("expected review");
  await setup.prepare(selected.review.id, () => {});
  return { workspace, deps, activate, setup };
}
/** The session before the restart: a claimed, attested, attached child that was never seen to exit. */
function lostSession(path: string) {
  const owner = reserveFirstRunOwnership(path);
  syntheticFirstRunWriter(path, 123);
  owner.attach({ url: "http://127.0.0.1:7654", pid: 123, exited: false, stop: async () => {} });
  return inspectFirstRunOwnership(path, true).latest!;
}
const attemptFiles = async (path: string, name = "000001") =>
  (await readdir(join(path, OWNERSHIP_DIRECTORY, name))).sort();

it("offers the previous-boot attempt, settles only on explicit confirmation, and lets startup proceed", async () => {
  const f = await rig();
  const lost = lostSession(f.workspace);
  restarted();
  const offered = await f.setup.status();
  expect(offered).toEqual({ state: "recovery", recovery: { state: "previous-boot", attemptId: lost.reservationId } });
  const before = await attemptFiles(f.workspace);
  // Reading state and ordinary Connect never settle it.
  expect(await new FirstRunSetup(f.deps).status()).toEqual(offered);
  await expect(f.setup.connect(() => {})).rejects.toThrow("reconciliation");
  expect(f.activate).not.toHaveBeenCalled();
  expect(await attemptFiles(f.workspace)).toEqual(before);
  // Confirmation names the attempt that was shown; another id changes nothing.
  await expect(f.setup.endPreviousSession(randomUUID(), () => {})).rejects.toThrow("was not marked ended");
  await expect(
    f.setup.endPreviousSession(lost.reservationId, () => {
      throw new Error("stale caller");
    }),
  ).rejects.toThrow();
  expect(await attemptFiles(f.workspace)).toEqual(before);
  expect(await f.setup.endPreviousSession(lost.reservationId, () => {})).toMatchObject({ state: "prepared" });
  expect(await attemptFiles(f.workspace)).toEqual([...before, REBOOT_SETTLEMENT].sort());
  const settlement = JSON.parse(
    await readFile(join(f.workspace, OWNERSHIP_DIRECTORY, "000001", REBOOT_SETTLEMENT), "utf8"),
  ) as Record<string, unknown>;
  expect(settlement).toMatchObject({
    reason: "person-confirmed-after-reboot",
    observation: "fence-free-after-reboot",
    actor: { kind: "person", surface: "desktop-app" },
  });
  // The journal verifies strictly, and retained continuations stay parked for explicit inspection.
  expect(inspectFirstRunOwnership(f.workspace).latest!.settled).toBe(true);
  expect(firstRunRequiresExplicitContinuationRecovery(f.workspace)).toBe(true);
  expect(await f.setup.status()).toMatchObject({ state: "prepared" });
  await f.setup.connect(() => {});
  expect(f.activate).toHaveBeenCalledOnce();
  expect(inspectFirstRunOwnership(f.workspace, true).latest!.reservationId).not.toBe(lost.reservationId);
});

it("leaves a same-boot attempt on the existing same-boot route", async () => {
  const f = await rig();
  const lost = reserveFirstRunOwnership(f.workspace);
  expect(await f.setup.status()).toMatchObject({ state: "prepared" });
  const { reservationId } = inspectFirstRunOwnership(f.workspace, true).latest!;
  await expect(endPreviousBootSession(f.workspace, reservationId, () => {})).rejects.toThrow("was not marked ended");
  expect(await attemptFiles(f.workspace)).toEqual(["claim.json"]);
  const request = await f.setup.prepareRecovery(() => {});
  expect(request).toMatchObject({ state: "recovery", recovery: { state: "ready" } });
  expect(await f.setup.status()).toEqual(request);
  if (request.state !== "recovery" || request.recovery.state === "previous-boot") throw new Error("expected ready");
  expect(await f.setup.reconcileRecovery(request.recovery.requestId, () => {})).toMatchObject({ state: "prepared" });
  expect(await attemptFiles(f.workspace)).toEqual(["claim.json", "recovery-request.json", "recovery.json"]);
  expect(() => lost.check()).toThrow("reconciliation");
});

it("refuses while anything holds the lifetime fence, and writes nothing", async () => {
  const f = await rig();
  const lost = lostSession(f.workspace);
  restarted();
  const before = await attemptFiles(f.workspace);
  const holder = await acquireFirstRunFence(fenceDirectory(f.workspace), () => undefined);
  try {
    await expect(f.setup.endPreviousSession(lost.reservationId, () => {})).rejects.toThrow("was not marked ended");
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
  expect(await attemptFiles(f.workspace)).toEqual(before);
  expect(await f.setup.status()).toMatchObject({ recovery: { state: "previous-boot" } });
  expect(await f.setup.endPreviousSession(lost.reservationId, () => {})).toMatchObject({ state: "prepared" });
});

it("refuses another host, a replaced store and an unattested store, and detects later tampering", async () => {
  const f = await rig();
  const lost = lostSession(f.workspace);
  const end = () => endPreviousBootSession(f.workspace, lost.reservationId, () => {});
  // Another host's boot is not a restart of this one: the fence here cannot speak for it.
  restart.boot = { bootId: randomUUID(), hostHash: "0".repeat(64) };
  expect(await f.setup.status()).toMatchObject({ state: "prepared" });
  await expect(end()).rejects.toThrow("was not marked ended");
  restarted();
  // The same store evidence as same-boot recovery: the attested writer's store, never a replacement.
  await rename(join(f.workspace, ".orca"), join(f.workspace, "retained-store"));
  await mkdir(join(f.workspace, ".orca"));
  await expect(end()).rejects.toThrow("was not marked ended");
  expect(await attemptFiles(f.workspace)).not.toContain(REBOOT_SETTLEMENT);
  const fresh = await rig();
  restart.boot = undefined;
  const claimOnly = reserveFirstRunOwnership(fresh.workspace);
  await mkdir(join(fresh.workspace, ".orca"));
  restarted();
  const { reservationId } = inspectFirstRunOwnership(fresh.workspace, true).latest!;
  // A store created after the claim without writer attestation stays uncertain.
  await expect(endPreviousBootSession(fresh.workspace, reservationId, () => {})).rejects.toThrow("not marked ended");
  await rm(join(fresh.workspace, ".orca"), { recursive: true });
  await endPreviousBootSession(fresh.workspace, reservationId, () => {});
  expect(() => claimOnly.check()).toThrow("reconciliation");
  const file = join(fresh.workspace, OWNERSHIP_DIRECTORY, "000001", REBOOT_SETTLEMENT);
  const original = await readFile(file, "utf8");
  const value = JSON.parse(original) as { boot: Record<string, unknown>; actor: { uid: string } };
  const claim = JSON.parse(
    await readFile(join(fresh.workspace, OWNERSHIP_DIRECTORY, "000001", "claim.json"), "utf8"),
  ) as { boot: Record<string, unknown> };
  for (const tampered of [
    { ...value, boot: claim.boot },
    { ...value, actor: { ...value.actor, uid: `${value.actor.uid}1` } },
    { ...value, reason: "automatic" },
  ]) {
    await writeFile(file, JSON.stringify(tampered) + "\n");
    expect(() => inspectFirstRunOwnership(fresh.workspace)).toThrow("reconciliation");
  }
  await writeFile(file, original);
  expect(() => inspectFirstRunOwnership(fresh.workspace)).not.toThrow();
  // Nothing may be added to an attempt after it was confirmed ended.
  await writeFile(join(fresh.workspace, OWNERSHIP_DIRECTORY, "000001", "child.json"), "{}\n");
  expect(() => inspectFirstRunOwnership(fresh.workspace)).toThrow("reconciliation");
});

it("settles a previous-boot attempt whose same-boot recovery request was left pending", async () => {
  const f = await rig();
  lostSession(f.workspace);
  const request = new FirstRunRecovery(f.workspace).prepare(() => {});
  restarted();
  // That request needed the earlier boot's fence and can no longer be reconciled.
  await expect(new FirstRunRecovery(f.workspace).reconcile(request.requestId, () => {})).rejects.toThrow();
  const offered = await f.setup.status();
  if (offered.state !== "recovery" || offered.recovery.state !== "previous-boot") throw new Error("expected offer");
  await f.setup.endPreviousSession(offered.recovery.attemptId, () => {});
  expect(inspectFirstRunOwnership(f.workspace).latest!.settled).toBe(true);
  expect(() => reserveFirstRunOwnership(f.workspace)).not.toThrow();
});
