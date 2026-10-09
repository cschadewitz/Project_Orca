/** Real disposable filesystem maintenance; synthetic protection is not native acceptance. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { NodeRecoveryDisk } from "../src/main/diagnostics/recovery-disk.js";
import { PosixFixtureNativeAdapter, type DiagnosticsKeyAdapter } from "../src/main/diagnostics/native-adapter.js";
import { createWindowsDiagnosticsKeyAdapter } from "../src/main/diagnostics/windows-key-adapter.js";
import { RECOVERY_LIMITS, type BootReading } from "../src/main/diagnostics/recovery-contract.js";

const parents: string[] = [];
const active: NodeRecoveryDisk[] = [];
afterEach(async () => {
  for (const disk of active.splice(0)) await disk.cleanExit().catch(() => undefined);
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function fixture(adapt: (keys: DiagnosticsKeyAdapter) => DiagnosticsKeyAdapter = (keys) => keys) {
  const parent = await mkdtemp(join(tmpdir(), "orca-maintenance-"));
  parents.push(parent);
  const root = join(parent, "owned");
  const protection = randomBytes(32);
  let available = true;
  const legacy: DiagnosticsKeyAdapter = {
    async available() {
      return available;
    },
    async wrap(bytes) {
      if (!available) throw new Error("unavailable");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", protection, nonce);
      const ciphertext = cipher.update(bytes);
      cipher.final();
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    async unwrap(bytes) {
      if (!available) throw new Error("unavailable");
      const decipher = createDecipheriv("aes-256-gcm", protection, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const plaintext = decipher.update(bytes.subarray(28));
      decipher.final();
      return plaintext;
    },
  };
  const keys = adapt(legacy);
  const native = new PosixFixtureNativeAdapter({ stopped: async () => true, moveNoReplace: async () => "refused" });
  const disk = new NodeRecoveryDisk({ root, keys, native });
  active.push(disk);
  const now: BootReading = { bootId: "synthetic-same-boot", elapsedMs: 1000 };
  await disk.writeSetting({ enabled: true, scopeVersion: 1, minutes: 5 });
  await disk.open(now);
  return {
    root,
    disk,
    keys,
    native,
    now,
    setAvailable(value: boolean) {
      available = value;
    },
  };
}
async function prior(f: Awaited<ReturnType<typeof fixture>>) {
  await f.disk.checkpoint(Buffer.from("prior checkpoint\n"), f.now, () => true);
  // All writes have settled and the fixture writer is explicitly retired. Real
  // SIGKILL/descendant cessation evidence belongs to the integration tests.
  await f.native.release(f.root);
  active.splice(active.indexOf(f.disk), 1);
  const disk = new NodeRecoveryDisk({ root: f.root, keys: f.keys, native: f.native });
  active.push(disk);
  expect(await disk.open({ ...f.now, elapsedMs: f.now.elapsedMs + 5 })).toBe(true);
  return disk;
}
async function maintenanceOnly(f: Awaited<ReturnType<typeof fixture>>) {
  await f.native.release(f.root);
  active.splice(active.indexOf(f.disk), 1);
  const disk = new NodeRecoveryDisk({ root: f.root, keys: f.keys, native: f.native });
  active.push(disk);
  return disk;
}
interface ManifestView {
  payload: { generation: number; current?: { slot: number; generation: number }; previous?: { slot: number } };
}
async function manifest(root: string): Promise<ManifestView> {
  return JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as ManifestView;
}

describe.skipIf(process.platform === "win32")("authenticated recovery maintenance", () => {
  it("Windows wrapper routing supports the real control/session envelopes through same-boot disk recovery", async () => {
    const f = await fixture((legacy) =>
      createWindowsDiagnosticsKeyAdapter(
        {
          abi: 1,
          platform: "win32",
          keyProtection: 1,
          // Only a controlled protection port. Actual current-user DPAPI is device evidence.
          protectKey: (bytes: Buffer) => legacy.wrap(bytes),
          unprotectKey: (bytes: Buffer) => legacy.unwrap(bytes),
        },
        legacy,
      ),
    );
    await f.disk.checkpoint(Buffer.from("enveloped checkpoint"), f.now, () => true);
    const control = await readFile(join(f.root, "control.key"));
    expect(control.subarray(0, 8).toString()).toBe("ORCADP01");
    const slot = (await manifest(f.root)).payload.current!.slot;
    const session = await readFile(join(f.root, `session-${slot}.key`));
    expect(session.subarray(0, 8).toString()).toBe("ORCADP01");
    // Retire this fixture's writer without creating another checkpoint/slot.
    await f.native.release(f.root);
    active.splice(active.indexOf(f.disk), 1);
    const reopened = new NodeRecoveryDisk({ root: f.root, keys: f.keys, native: f.native });
    active.push(reopened);
    expect(await reopened.open({ ...f.now, elapsedMs: f.now.elapsedMs + 5 })).toBe(true);
    expect((await reopened.previous({ ...f.now, elapsedMs: f.now.elapsedMs + 6 }))?.bytes).toEqual(
      Buffer.from("enveloped checkpoint"),
    );
    expect(await readFile(join(f.root, "control.key"))).toEqual(control);
    expect(await readFile(join(f.root, `session-${slot}.key`))).toEqual(session);
  });
  it("expires crashed current on a new adapter without opening capture or promoting history", async () => {
    const f = await fixture();
    await f.disk.checkpoint(Buffer.from("crashed current\n"), f.now, () => true);
    await f.disk.writeExportState({ current: { id: "old-export", phase: "intent" } });
    const metadata = await readFile(join(f.root, "export.json"));
    const disk = await maintenanceOnly(f);
    expect(await disk.maintain({ ...f.now, elapsedMs: f.now.elapsedMs + RECOVERY_LIMITS.retentionMs })).toBe(false);
    expect((await manifest(f.root)).payload.current).toBeUndefined();
    expect((await manifest(f.root)).payload.previous).toBeUndefined();
    expect((await readdir(f.root)).filter((name) => /^(slot-|session-)/.test(name))).toEqual([]);
    expect(await readFile(join(f.root, "export.json"))).toEqual(metadata);
    await expect(
      disk.checkpoint(
        Buffer.from("forbidden capture\n"),
        { ...f.now, elapsedMs: f.now.elapsedMs + RECOVERY_LIMITS.retentionMs },
        () => true,
      ),
    ).rejects.toThrow("off");
  });
  it("preserves eligible crashed current and its role when a maintenance-only adapter closes", async () => {
    const f = await fixture();
    await f.disk.checkpoint(Buffer.from("crashed current\n"), f.now, () => true);
    const authority = await readFile(join(f.root, "manifest.json"));
    const slot = (await manifest(f.root)).payload.current!.slot;
    const ciphertext = await readFile(join(f.root, `slot-${slot}.bin`));
    const disk = await maintenanceOnly(f);
    expect(await disk.maintain({ ...f.now, elapsedMs: f.now.elapsedMs + 5 })).toBe(false);
    await disk.cleanExit();
    expect(await readFile(join(f.root, "manifest.json"))).toEqual(authority);
    expect(await readFile(join(f.root, `slot-${slot}.bin`))).toEqual(ciphertext);
    expect((await manifest(f.root)).payload.previous).toBeUndefined();
    await expect(disk.maintain(f.now)).rejects.toThrow("off");
  });
  it("refuses lost protection on a new maintenance-only adapter without modifying history", async () => {
    const f = await fixture();
    await f.disk.checkpoint(Buffer.from("crashed current\n"), f.now, () => true);
    const authority = await readFile(join(f.root, "manifest.json"));
    const disk = await maintenanceOnly(f);
    f.setAvailable(false);
    await expect(disk.maintain({ ...f.now, elapsedMs: f.now.elapsedMs + RECOVERY_LIMITS.retentionMs })).rejects.toThrow(
      "unavailable",
    );
    expect(await readFile(join(f.root, "manifest.json"))).toEqual(authority);
    expect((await readdir(f.root)).filter((name) => name.endsWith(".bin"))).toHaveLength(1);
    f.setAvailable(true);
  });
  it("resets a closed maintenance fence only after successful capture preflight", async () => {
    const f = await fixture();
    await f.disk.cleanExit();
    await f.disk.writeSetting({ enabled: true, scopeVersion: 1, minutes: 5 });
    await expect(f.disk.maintain(f.now)).rejects.toThrow("off");
    f.setAvailable(false);
    await expect(f.disk.open(f.now)).rejects.toThrow("unavailable");
    await expect(f.disk.maintain(f.now)).rejects.toThrow("off");
    f.setAvailable(true);
    expect(await f.disk.open(f.now)).toBe(false);
    expect(await f.disk.maintain(f.now)).toBe(false);
  });
  it.each([false, true])("does not allocate keys for empty history with export-only=%s", async (withExport) => {
    const f = await fixture();
    await f.disk.cleanup();
    if (withExport) await f.disk.writeExportState({ current: { id: "export-only", phase: "unknown" } });
    const disk = await maintenanceOnly(f);
    f.setAvailable(false);
    expect(await disk.maintain(f.now)).toBe(false);
    expect((await readdir(f.root)).filter((name) => /^(slot-|session-|control\.key|manifest\.)/.test(name))).toEqual(
      [],
    );
    if (withExport) expect((await disk.readExportState()).current?.id).toBe("export-only");
    await expect(disk.checkpoint(Buffer.from("forbidden\n"), f.now, () => true)).rejects.toThrow("off");
  });
  it("refuses missing authority with stray history and missing previously cached authority", async () => {
    const f = await fixture();
    await f.disk.checkpoint(Buffer.from("crashed current\n"), f.now, () => true);
    const authority = await readFile(join(f.root, "manifest.json"));
    const disk = await maintenanceOnly(f);
    await rm(join(f.root, "manifest.json"));
    await expect(disk.maintain(f.now)).rejects.toThrow("unavailable");
    await writeFile(join(f.root, "manifest.json"), authority, { mode: 0o600 });
    expect(await disk.maintain(f.now)).toBe(false);
    await rm(join(f.root, "manifest.json"));
    await rm(join(f.root, "control.key"));
    for (const name of await readdir(f.root)) if (/^(slot-|session-)/.test(name)) await rm(join(f.root, name));
    await expect(disk.maintain(f.now)).rejects.toThrow("unavailable");
  });
  it.each(["disable", "cleanup", "close"] as const)("fences pending inactive maintenance before %s", async (action) => {
    const f = await fixture();
    await f.disk.checkpoint(Buffer.from("crashed current\n"), f.now, () => true);
    const authority = await readFile(join(f.root, "manifest.json"));
    const disk = await maintenanceOnly(f);
    const original = f.native.write.bind(f.native);
    let observe!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      observe = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.native.write = async (file, bytes) => {
      await original(file, bytes);
      if (bytes.toString().startsWith('{"payload":')) {
        observe();
        await released;
      }
    };
    const pending = disk.maintain({ ...f.now, elapsedMs: f.now.elapsedMs + RECOVERY_LIMITS.retentionMs });
    await started;
    const revoked =
      action === "disable"
        ? disk.writeSetting({ enabled: false, scopeVersion: 1, minutes: 5 })
        : action === "cleanup"
          ? disk.cleanup()
          : disk.cleanExit();
    release();
    await expect(pending).rejects.toThrow("off");
    await revoked;
    if (action === "cleanup")
      expect((await readdir(f.root)).filter((name) => /^(slot-|session-|control\.key|manifest\.)/.test(name))).toEqual(
        [],
      );
    else expect(await readFile(join(f.root, "manifest.json"))).toEqual(authority);
    await expect(disk.maintain(f.now)).rejects.toThrow("off");
    f.native.write = original;
  });
  it("expires an unopened prior candidate while new checkpoints continue, without removing current", async () => {
    const f = await fixture();
    const disk = await prior(f);
    const before = { ...f.now, elapsedMs: f.now.elapsedMs + RECOVERY_LIMITS.retentionMs - 5000 };
    expect(await disk.maintain(before)).toBe(true);
    await disk.checkpoint(Buffer.from("new current\n"), before, () => true);
    const committed = (await manifest(f.root)).payload.current!;
    const ciphertext = await readFile(join(f.root, `slot-${committed.slot}.bin`));
    expect(await disk.maintain({ ...before, elapsedMs: before.elapsedMs + 5000 })).toBe(false);
    expect((await manifest(f.root)).payload.previous).toBeUndefined();
    expect((await manifest(f.root)).payload.current).toEqual(committed);
    expect(await readFile(join(f.root, `slot-${committed.slot}.bin`))).toEqual(ciphertext);
    expect((await readdir(f.root)).filter((name) => name.endsWith(".bin"))).toHaveLength(1);
  });
  it("expires a prior candidate with no checkpoint and no explicit preview", async () => {
    const f = await fixture();
    const disk = await prior(f);
    expect(await disk.maintain({ ...f.now, elapsedMs: f.now.elapsedMs + RECOVERY_LIMITS.retentionMs })).toBe(false);
    expect((await readdir(f.root)).filter((name) => /^(slot-|session-)/.test(name))).toEqual([]);
  });
  it("expires an idle current checkpoint at its own original anchor without refreshing retention", async () => {
    const f = await fixture();
    await f.disk.checkpoint(Buffer.from("idle current\n"), f.now, () => true);
    const committed = (await manifest(f.root)).payload.current!;
    expect(await f.disk.maintain({ ...f.now, elapsedMs: f.now.elapsedMs + RECOVERY_LIMITS.retentionMs - 1 })).toBe(
      false,
    );
    expect((await manifest(f.root)).payload.current).toEqual(committed);
    expect(await f.disk.maintain({ ...f.now, elapsedMs: f.now.elapsedMs + RECOVERY_LIMITS.retentionMs })).toBe(false);
    expect((await manifest(f.root)).payload.current).toBeUndefined();
    expect((await readdir(f.root)).filter((name) => /^(slot-|session-)/.test(name))).toEqual([]);
  });
  it("durably revokes before a failed expired-file unlink and safely retries", async () => {
    const f = await fixture();
    const disk = await prior(f);
    const original = f.native.remove.bind(f.native);
    let fail = true;
    f.native.remove = async (path) => {
      if (fail && basename(path).endsWith(".bin")) throw new Error("cleanup_pending");
      await original(path);
    };
    const expiry = { ...f.now, elapsedMs: f.now.elapsedMs + RECOVERY_LIMITS.retentionMs };
    await expect(disk.maintain(expiry)).rejects.toThrow("cleanup_pending");
    expect((await manifest(f.root)).payload.previous).toBeUndefined();
    expect((await readdir(f.root)).filter((name) => name.endsWith(".bin"))).toHaveLength(1);
    fail = false;
    expect(await disk.maintain(expiry)).toBe(false);
    expect((await readdir(f.root)).filter((name) => /^(slot-|session-)/.test(name))).toEqual([]);
  });
  it.each(["slot", "manifest"] as const)(
    "cleans an orphan session wrapper after %s failure and admits a later checkpoint",
    async (failure) => {
      const f = await fixture();
      const originalWrite = f.native.write.bind(f.native);
      const originalReplace = f.native.replace.bind(f.native);
      f.native.write = async (file, bytes) => {
        if (failure === "slot" && bytes.length > 2000) throw new Error("unavailable");
        await originalWrite(file, bytes);
      };
      f.native.replace = async (source, destination) => {
        if (failure === "manifest" && basename(destination) === "manifest.json") throw new Error("unavailable");
        await originalReplace(source, destination);
      };
      await expect(f.disk.checkpoint(Buffer.alloc(4096), f.now, () => true)).rejects.toThrow("unavailable");
      expect((await readdir(f.root)).filter((name) => name.startsWith("session-"))).toHaveLength(1);
      f.native.write = originalWrite;
      f.native.replace = originalReplace;
      expect(await f.disk.maintain(f.now)).toBe(false);
      expect((await readdir(f.root)).filter((name) => /^(slot-|session-)|manifest\.json\.tmp$/.test(name))).toEqual([]);
      await f.disk.checkpoint(Buffer.from("later accepted\n"), f.now, () => true);
      expect((await manifest(f.root)).payload.current?.generation).toBe(1);
    },
  );
  it("uses a physically committed replacement after its adapter reports failure", async () => {
    const f = await fixture();
    const original = f.native.replace.bind(f.native);
    f.native.replace = async (source, destination) => {
      await original(source, destination);
      if (basename(destination) === "manifest.json") throw new Error("unavailable");
    };
    await expect(f.disk.checkpoint(Buffer.from("physically committed\n"), f.now, () => true)).rejects.toThrow(
      "unavailable",
    );
    f.native.replace = original;
    const committed = (await manifest(f.root)).payload.current!;
    const ciphertext = await readFile(join(f.root, `slot-${committed.slot}.bin`));
    expect(await f.disk.maintain(f.now)).toBe(false);
    expect(await readFile(join(f.root, `slot-${committed.slot}.bin`))).toEqual(ciphertext);
    await f.disk.checkpoint(Buffer.from("next generation\n"), f.now, () => true);
    expect((await manifest(f.root)).payload.current?.generation).toBe(2);
  });
  it("preserves unresolved private export metadata and staging during maintenance", async () => {
    const f = await fixture();
    await f.disk.writeExportState({
      current: { id: "unresolved", phase: "intent" },
      summary: { id: "earlier", outcome: "unknown", acknowledged: true, olderUnknowns: false },
    });
    await f.disk.stageExport("unresolved", Buffer.from("approved staged export\n"));
    const metadata = await readFile(join(f.root, "export.json"));
    const staging = await readFile(join(f.root, "export-stage.tmp"));
    expect(await f.disk.maintain(f.now)).toBe(false);
    expect(await readFile(join(f.root, "export.json"))).toEqual(metadata);
    expect(await readFile(join(f.root, "export-stage.tmp"))).toEqual(staging);
  });
  it("refuses lost control protection instead of clearing artifacts or claiming success", async () => {
    const f = await fixture();
    await f.disk.checkpoint(Buffer.from("valid current\n"), f.now, () => true);
    await writeFile(join(f.root, "slot-1.bin"), "orphan", { mode: 0o600 });
    const before = await readdir(f.root);
    f.setAvailable(false);
    await expect(f.disk.maintain(f.now)).rejects.toThrow("unavailable");
    expect(await readdir(f.root)).toEqual(before);
    f.setAvailable(true);
    expect(await f.disk.maintain(f.now)).toBe(false);
    expect(await readdir(f.root)).not.toContain("slot-1.bin");
  });
  it("refuses a missing referenced session wrapper without erasing valid current ciphertext", async () => {
    const f = await fixture();
    await f.disk.checkpoint(Buffer.from("valid current\n"), f.now, () => true);
    const current = (await manifest(f.root)).payload.current!;
    const bytes = await readFile(join(f.root, `slot-${current.slot}.bin`));
    await rm(join(f.root, `session-${current.slot}.key`));
    await expect(f.disk.maintain(f.now)).rejects.toThrow("unavailable");
    expect(await readFile(join(f.root, `slot-${current.slot}.bin`))).toEqual(bytes);
  });
  it("rejects altered record framing without decrypting or clearing current content", async () => {
    const f = await fixture();
    await f.disk.checkpoint(Buffer.from("valid current\n"), f.now, () => true);
    const current = (await manifest(f.root)).payload.current!;
    const path = join(f.root, `slot-${current.slot}.bin`);
    const altered = await readFile(path);
    altered.writeUInt32BE(0);
    await writeFile(path, altered, { mode: 0o600 });
    await expect(f.disk.maintain(f.now)).rejects.toThrow("unavailable");
    expect(await readFile(path)).toEqual(altered);
  });
  it("refuses malformed or missing authority without promoting or cleaning stray files", async () => {
    const f = await fixture();
    await f.disk.checkpoint(Buffer.from("valid current\n"), f.now, () => true);
    const authority = await readFile(join(f.root, "manifest.json"));
    const altered = JSON.parse(authority.toString()) as ManifestView;
    altered.payload.generation++;
    await writeFile(join(f.root, "manifest.json"), JSON.stringify(altered), { mode: 0o600 });
    await expect(f.disk.maintain(f.now)).rejects.toThrow("unavailable");
    await writeFile(join(f.root, "manifest.json"), "{}", { mode: 0o600 });
    const before = await readdir(f.root);
    await expect(f.disk.maintain(f.now)).rejects.toThrow("unavailable");
    expect(await readdir(f.root)).toEqual(before);
    await rm(join(f.root, "manifest.json"));
    await expect(f.disk.maintain(f.now)).rejects.toThrow("unavailable");
    await writeFile(join(f.root, "manifest.json"), authority, { mode: 0o600 });
  });
  it.each(["boot", "rollback"] as const)(
    "revokes prior recovery on %s uncertainty and refuses ready",
    async (uncertainty) => {
      const f = await fixture();
      const disk = await prior(f);
      await disk.checkpoint(
        Buffer.from("current before uncertain clock\n"),
        { ...f.now, elapsedMs: f.now.elapsedMs + 10 },
        () => true,
      );
      const now =
        uncertainty === "boot" ? { ...f.now, bootId: "different-boot" } : { ...f.now, elapsedMs: f.now.elapsedMs - 1 };
      await expect(disk.maintain(now)).rejects.toThrow("age_uncertain");
      expect((await manifest(f.root)).payload.previous).toBeUndefined();
      expect((await manifest(f.root)).payload.current).toBeUndefined();
      expect((await readdir(f.root)).filter((name) => /^(slot-|session-)/.test(name))).toEqual([]);
    },
  );
});
