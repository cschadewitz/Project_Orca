/** Ownership/admission regressions; synthetic ports are not native acceptance. */
import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlledPayloadMemory } from "../src/main/diagnostics/payload-memory.js";
import { PayloadScope } from "../src/main/diagnostics/payload-scope.js";
import { NodeRecoveryDisk } from "../src/main/diagnostics/recovery-disk.js";
import { RECOVERY_LIMITS } from "../src/main/diagnostics/recovery-contract.js";
import type { RecoveryNativeAdapter } from "../src/main/diagnostics/native-adapter.js";
import { SyntheticKeys } from "./recovery-preparation/implementation-fixture.js";

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

it("reuses aligned storage, erases released bytes and refuses before the unchanged ceiling", () => {
  const memory = new ControlledPayloadMemory();
  expect(memory.stats().allocatedBytes).toBe(0);
  const ring = memory.allocate(81_920),
    first = memory.from("synthetic bytes");
  const offset = first.bytes.byteOffset;
  first.release();
  expect(first.bytes.every((byte) => byte === 0)).toBe(true);
  const second = memory.from("next");
  expect(second.bytes.byteOffset).toBe(offset);
  const release = memory.allowance(RECOVERY_LIMITS.payloadBytes - memory.stats().arenaBytes);
  expect(memory.stats().allocatedBytes).toBe(RECOVERY_LIMITS.payloadBytes);
  expect(() => memory.allowance(1)).toThrow("capacity_limited");
  expect(memory.stats().peakBytes).toBe(RECOVERY_LIMITS.payloadBytes);
  ring.release();
  second.release();
  release();
  release();
  expect(memory.stats().allocatedBytes).toBe(0);
});

it("bounds metadata/ring backing storage before growing for a report, without moving live bytes", () => {
  const memory = new ControlledPayloadMemory();
  const metadata = memory.from("synthetic metadata");
  const ring = memory.allocate(81_920);
  ring.bytes.fill(7);
  expect(memory.stats().arenaBytes).toBeLessThanOrEqual(131_072);
  const original = ring.bytes.buffer;
  const report = memory.allocate(RECOVERY_LIMITS.exportBytes);
  report.bytes.fill(9);
  expect(memory.stats().arenaBytes).toBe(131_072 + RECOVERY_LIMITS.exportBytes);
  expect(ring.bytes.buffer).toBe(original);
  expect(ring.bytes.every((byte) => byte === 7)).toBe(true);
  metadata.release();
  ring.release();
  expect(ring.bytes.every((byte) => byte === 0)).toBe(true);
  expect(report.bytes.every((byte) => byte === 9)).toBe(true);
  const again = memory.allocate(81_920);
  expect(again.bytes.buffer).toBe(original);
  expect(again.bytes.every((byte) => byte === 0)).toBe(true);
  again.release();
  report.release();
  expect(memory.stats().allocatedBytes).toBe(0);
});

it("admits arena growth before allocation and keeps outstanding provider allowances charged", () => {
  const memory = new ControlledPayloadMemory();
  const metadata = memory.from("synthetic metadata");
  const release = memory.allowance(RECOVERY_LIMITS.payloadBytes - memory.stats().arenaBytes);
  const before = memory.stats();
  expect(() => memory.allocate(RECOVERY_LIMITS.exportBytes)).toThrow("capacity_limited");
  expect(memory.stats()).toEqual(before);
  metadata.release();
  expect(memory.stats().externalAllowanceBytes).toBe(before.externalAllowanceBytes);
  release();
  expect(memory.stats().allocatedBytes).toBe(0);
});

it("charges every region through the original arena/provider ceilings and reuses fragmented space", () => {
  const memory = new ControlledPayloadMemory();
  const leases = Array.from({ length: 40 }, () => memory.allocate(131_072));
  expect(memory.stats().arenaBytes).toBe(5 * RECOVERY_LIMITS.exportBytes);
  const release = memory.allowance(3 * RECOVERY_LIMITS.exportBytes);
  expect(memory.stats().allocatedBytes).toBe(RECOVERY_LIMITS.payloadBytes);
  expect(() => memory.allocate(1)).toThrow("capacity_limited");
  expect(() => memory.allowance(1)).toThrow("capacity_limited");
  const backing = leases[17]!.bytes.buffer;
  leases[17]!.release();
  const first = memory.allocate(65_536),
    second = memory.allocate(65_536);
  expect(first.bytes.buffer).toBe(backing);
  expect(second.bytes.buffer).toBe(backing);
  first.release();
  second.release();
  const combined = memory.allocate(131_072);
  expect(combined.bytes.buffer).toBe(backing);
  combined.release();
  for (const lease of leases) lease.release();
  release();
  expect(memory.stats().allocatedBytes).toBe(0);
});

it("charges before a provider starts and retains its returned bytes until actual disposal", async () => {
  const memory = new ControlledPayloadMemory(),
    scope = new PayloadScope(memory);
  let settle!: (bytes: Buffer) => void;
  const pending = scope.provider(32_768, () => {
    expect(memory.stats().externalAllowanceBytes).toBe(32_768);
    return new Promise((resolve) => {
      settle = resolve;
    });
  });
  expect(memory.stats().externalAllowanceBytes).toBe(32_768);
  const output = Buffer.from("provider synthetic");
  settle(output);
  expect(await pending).toBe(output);
  expect(memory.stats().externalAllowanceBytes).toBe(32_768);
  scope.dispose();
  expect(output.every((byte) => byte === 0)).toBe(true);
  expect(memory.stats().allocatedBytes).toBe(0);
});

it("bounds maximum checkpoint/open buffers, owns returned plaintext and retires persistent keys", async () => {
  const parent = await mkdtemp(join(tmpdir(), "orca-payload-regression-"));
  parents.push(parent);
  const root = join(parent, "private"),
    memory = new ControlledPayloadMemory();
  const native: RecoveryNativeAdapter = {
    verifyRoot: async (path) => {
      await mkdir(path, { recursive: true });
      return true;
    },
    acquire: async () => true,
    release: async () => undefined,
    replace: rename,
    write: async (handle, bytes) => {
      await handle.writeFile(bytes);
      await handle.sync();
    },
    remove: unlink,
    validateDestination: async () => false,
    publish: async () => "refused",
    writersStopped: async () => true,
  };
  const keys = new SyntheticKeys();
  const disk = new NodeRecoveryDisk({ root, native, keys, payload: memory });
  const anchor = { bootId: "synthetic-payload", elapsedMs: 1000 };
  // Keep a ring lease as the production composition does between operations.
  const ring = memory.allocate(81_920),
    input = memory.allocate(RECOVERY_LIMITS.exportBytes);
  for (let index = 0; index < input.bytes.length; index++) input.bytes[index] = index & 255;
  try {
    await disk.writeSetting({ enabled: true, scopeVersion: 1, minutes: 5 });
    await disk.open(anchor);
    await disk.checkpoint(input.bytes, anchor, () => true);
    input.release();
    // Synthetic restart: old writes settled, explicitly retire its lease/keys
    // without relabelling the durable crashed current as a clean exit.
    const restarted = new NodeRecoveryDisk({ root, native, keys, payload: memory });
    try {
      expect(await restarted.open({ ...anchor, elapsedMs: 1001 })).toBe(true);
      const previous = await restarted.previous({ ...anchor, elapsedMs: 1002 });
      expect(previous?.bytes.length).toBe(RECOVERY_LIMITS.exportBytes);
      expect(previous?.bytes.every((byte, index) => byte === (index & 255))).toBe(true);
      previous?.dispose?.();
      expect(previous?.bytes.every((byte) => byte === 0)).toBe(true);
      expect(memory.stats().peakBytes).toBeLessThanOrEqual(RECOVERY_LIMITS.payloadBytes);
    } finally {
      await restarted.cleanExit();
    }
  } finally {
    input.release();
    ring.release();
    await disk.cleanExit();
  }
  expect(memory.stats().allocatedBytes).toBe(0);
});
