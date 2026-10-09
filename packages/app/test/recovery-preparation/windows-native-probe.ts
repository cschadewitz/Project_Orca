import { previewText } from "./preview-text.js";
/** Native x64 Windows evidence in a caller-selected disposable parent, never app consent. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, link, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createHandleRelativeStorage, type NativeStorageBackend } from "../../src/main/diagnostics/native-storage.js";
import { createNativeDiagnosticsClock } from "../../src/main/diagnostics/native-clock.js";
import { NodeRecoveryDisk } from "../../src/main/diagnostics/recovery-disk.js";
import { RecoveryController } from "../../src/main/diagnostics/recovery-controller.js";
import { SyntheticKeys, value } from "./implementation-fixture.js";
import type { BootReading } from "../../src/main/diagnostics/recovery-contract.js";

assert.equal(process.platform, "win32");
const require = createRequire(import.meta.url);
const nativeDirectory = fileURLToPath(new URL("../../native/diagnostics/build/Release/", import.meta.url));
const backend = require(join(nativeDirectory, "diagnostics_storage.node")) as NativeStorageBackend;
const clock = createNativeDiagnosticsClock(require(join(nativeDirectory, "diagnostics_clock.node")) as unknown);
assert.equal(backend.platform, "win32");
const reading = () => {
  const now = clock.read();
  assert.ok(now);
  return now;
};
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
const writeFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
const entry = fileURLToPath(import.meta.url);
if (process.argv[2] === "child-clock") {
  process.send?.(reading());
  process.disconnect?.();
} else if (process.argv[2] === "child-checkpoint" || process.argv[2] === "child-export") {
  const root = resolve(process.argv[3]!);
  const exportProbe = process.argv[2] === "child-export";
  const parked: NativeStorageBackend = {
    ...backend,
    call: async (...args) => {
      if (exportProbe && args[0] === "publish") {
        process.send?.("export-dispatch-parked");
        return await new Promise<unknown>(() => undefined);
      }
      return backend.call(...args);
    },
  };
  const storage = createHandleRelativeStorage(root, parked);
  const disk = new NodeRecoveryDisk({ root, native: storage.native, files: storage.files, keys: new SyntheticKeys() });
  const controller = new RecoveryController({
    disk,
    clock,
    productionEnabled: true,
    chooseDestination: async () => join(dirname(root), "unpublished.json"),
  });
  await controller.initialize();
  value(await controller.setEnabled(true, 1));
  for (let index = 0; index < (exportProbe ? 1 : 8192); index++)
    assert.equal(controller.record("run", "run_failed"), true);
  await controller.checkpoint();
  if (exportProbe) {
    const preview = await previewText(controller, value(await controller.preparePreview("current")));
    const selected = value(await controller.chooseDestination(preview.handle));
    void controller.save(preview.handle, selected.token);
  } else process.send?.("checkpoint-committed");
  // Parent terminates this owned fixture only after the native checkpoint has settled.
  setInterval(() => undefined, 1000);
} else {
  const parent = resolve(process.argv[2]!);
  const base = await mkdtemp(join(parent, "orca-win-task12-"));
  assert.equal(dirname(base), parent);
  assert.ok(base.startsWith(join(parent, "orca-win-task12-")));
  const root = join(base, "private");
  const storage = createHandleRelativeStorage(root, backend);
  const other = createHandleRelativeStorage(root, backend);
  const cases: Record<string, boolean> = {};
  const children = new Set<ReturnType<typeof fork>>();
  const child = (mode: string, path?: string) => {
    const process = fork(entry, [mode, ...(path ? [path] : [])], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    children.add(process);
    process.stderr?.resume(); // No raw exception/path output is retained or copied.
    return process;
  };
  const message = async (process: ReturnType<typeof fork>) => {
    const timeout = setTimeout(() => process.kill(), 15_000);
    try {
      return await Promise.race([
        once(process, "message"),
        once(process, "exit").then(() => {
          throw new Error("child-unavailable");
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const create = async (name: string, bytes: Buffer) => {
    const file = await storage.files.open(join(root, name), writeFlags, 0o600);
    try {
      await storage.native.write(file, bytes);
    } finally {
      await file.close();
    }
  };
  try {
    const before = reading();
    for (let restart = 0; restart < 2; restart++) {
      const process = child("child-clock");
      const exited = once(process, "exit");
      const [native] = await message(process);
      const observed = native as BootReading;
      assert.equal(observed.bootId, before.bootId);
      assert.ok(observed.elapsedMs >= before.elapsedMs && observed.elapsedMs <= reading().elapsedMs);
      await exited;
      children.delete(process);
    }
    const original = Date.now;
    try {
      Date.now = () => -1;
      assert.ok(reading().elapsedMs >= before.elapsedMs);
    } finally {
      Date.now = original;
    }
    cases.kernelClockAcrossProcessesAndWallClockIndependence = true;

    await assert.rejects(backend.call("rootStat", {}, undefined, "", "", undefined, 0, 0, 0));
    assert.equal(await storage.native.verifyRoot(root), true);
    assert.equal(await storage.native.acquire(root), true);
    assert.equal(await other.native.acquire(root), false);
    assert.equal(await other.native.writersStopped(root), false);
    cases.privateRootAndExclusiveWriter = true;
    const inherited = join(base, "inherited");
    await mkdir(inherited);
    const unsafe = createHandleRelativeStorage(inherited, backend);
    try {
      assert.equal(await unsafe.native.verifyRoot(inherited), false);
    } finally {
      await unsafe.close();
    }
    assert.deepEqual(await readdir(inherited), []);
    cases.existingNonPrivateDaclRefusedWithoutRepair = true;
    await assert.rejects(rename(base, `${base}-swapped`));
    cases.heldAncestorSwapBlocked = true;

    await create("setting.json", Buffer.from("synthetic-control"));
    await link(join(root, "setting.json"), join(base, "alias"));
    await assert.rejects(storage.files.open(join(root, "setting.json"), readFlags));
    await assert.rejects(storage.native.remove(join(root, "setting.json")));
    assert.equal(await readFile(join(base, "alias"), "utf8"), "synthetic-control");
    await unlink(join(base, "alias"));
    await storage.native.remove(join(root, "setting.json"));
    cases.hardlinksRefusedAndPreserved = true;
    await symlink(root, join(base, "junction"), "junction");
    const junction = createHandleRelativeStorage(join(base, "junction"), backend);
    try {
      assert.equal(await junction.native.verifyRoot(join(base, "junction")), false);
    } finally {
      await junction.close();
    }
    await mkdir(join(base, "outside"));
    await symlink(join(base, "outside"), join(root, "export-stage.tmp"), "junction");
    assert.equal((await storage.files.lstat(join(root, "export-stage.tmp"))).isSymbolicLink(), true);
    await assert.rejects(storage.files.open(join(root, "export-stage.tmp"), readFlags));
    await assert.rejects(storage.native.remove(join(root, "export-stage.tmp")));
    assert.deepEqual(await readdir(join(base, "outside")), []);
    await unlink(join(root, "export-stage.tmp"));
    cases.reparseRootAndChildRefusedWithoutFollowing = true;

    for (const name of ["unknown.bin", "..", "../setting.json", "setting.json:stream"])
      await assert.rejects(storage.files.open(join(root, name), readFlags));
    for (const name of ["CON", "report.json:stream", "report.json.", "report.json "])
      assert.equal(await storage.native.validateDestination(root, join(base, name)), false);
    assert.equal(await storage.native.validateDestination(root, join(root, "report.json")), false);
    cases.closedNamesDeviceNamesAndStreamsRefused = true;
    const oversized = await storage.files.open(join(root, "setting.json"), writeFlags, 0o600);
    try {
      await assert.rejects(storage.native.write(oversized, Buffer.alloc(4097)));
    } finally {
      await oversized.close();
    }
    await storage.native.remove(join(root, "setting.json"));
    const tooLarge = await storage.files.open(join(root, "export-stage.tmp"), writeFlags, 0o600);
    try {
      await assert.rejects(storage.native.write(tooLarge, Buffer.alloc(1048577)));
    } finally {
      await tooLarge.close();
    }
    await storage.native.remove(join(root, "export-stage.tmp"));
    const handles = [];
    try {
      for (const name of ["setting.json", "manifest.json", "control.key", "export.json"])
        handles.push(await storage.files.open(join(root, name), writeFlags, 0o600));
      await assert.rejects(storage.files.open(join(root, "session-0.key"), writeFlags, 0o600));
      assert.equal(await storage.native.writersStopped(root), false);
      await assert.rejects(storage.close());
    } finally {
      for (const file of handles) await file.close();
    }
    for (const name of ["setting.json", "manifest.json", "control.key", "export.json"])
      await storage.native.remove(join(root, name));
    cases.fileSizeHandleAndCloseBounds = true;

    const destinationParent = join(base, "destination");
    await mkdir(destinationParent);
    const destination = join(destinationParent, "report.json");
    const bytes = Buffer.alloc(1048576, 0x41);
    await create("export-stage.tmp", bytes);
    const stage = await storage.files.lstat(join(root, "export-stage.tmp"));
    const identity = { device: String(stage.dev), inode: String(stage.ino) };
    assert.equal(await storage.native.validateDestination(root, destination), true);
    await assert.rejects(rename(destinationParent, `${destinationParent}-swapped`));
    await writeFile(destination, "collision", { flag: "wx" });
    assert.equal(
      await storage.native.publish(root, join(root, "export-stage.tmp"), destination, identity, () => true),
      "refused",
    );
    assert.equal(await readFile(destination, "utf8"), "collision");
    await unlink(destination);
    assert.equal(
      await storage.native.publish(root, join(root, "export-stage.tmp"), destination, identity, () => false),
      "refused",
    );
    assert.equal(
      await storage.native.publish(root, join(root, "export-stage.tmp"), destination, identity, () => true),
      "saved",
    );
    assert.deepEqual(await readFile(destination), bytes);
    await assert.rejects(storage.files.lstat(join(root, "export-stage.tmp")), { code: "ENOENT" });
    assert.equal(await storage.native.writersStopped(root), true);
    cases.exactOneMiBNoReplaceConsentAndDestinationLease = true;
    await storage.close();
    await other.close();

    const crashRoot = join(base, "crash");
    const crashed = child("child-checkpoint", crashRoot);
    assert.equal((await message(crashed))[0], "checkpoint-committed");
    const recovery = createHandleRelativeStorage(crashRoot, backend);
    assert.equal(await recovery.native.acquire(crashRoot), false);
    const exited = once(crashed, "exit");
    crashed.kill();
    await exited;
    children.delete(crashed);
    assert.equal(await recovery.native.acquire(crashRoot), true);
    const disk = new NodeRecoveryDisk({
      root: crashRoot,
      native: recovery.native,
      files: recovery.files,
      keys: new SyntheticKeys(),
    });
    const controller = new RecoveryController({
      disk,
      clock,
      productionEnabled: true,
      chooseDestination: async () => join(base, "recovered.json"),
    });
    try {
      await controller.initialize();
      assert.equal(controller.status().previous, true);
      const previous = await previewText(controller, value(await controller.preparePreview("previous")));
      const report = JSON.parse(previous.text) as { events: unknown[] };
      assert.equal(report.events.length, 8192);
      assert.ok(!previous.text.includes(base) && !previous.text.includes(before.bootId));
      const selected = value(await controller.chooseDestination(previous.handle));
      assert.equal(value(await controller.save(previous.handle, selected.token)).lastSaveOutcome, "saved");
      assert.equal(await readFile(join(base, "recovered.json"), "utf8"), previous.text);
      value(await controller.setEnabled(false, 1));
      assert.ok(
        !(await readdir(crashRoot)).some(
          (name) => name.startsWith("slot-") || name.startsWith("session-") || name.startsWith("export"),
        ),
      );
      assert.equal(await readFile(join(base, "recovered.json"), "utf8"), previous.text);
      cases.forcedProcessExitNativeCheckpointRecoveryAndOptOut = true;
    } finally {
      await controller.cleanExit();
      await disk.waitForSettlement();
      await recovery.close();
    }
    const unknownRoot = join(base, "unknown");
    const exporter = child("child-export", unknownRoot);
    assert.equal((await message(exporter))[0], "export-dispatch-parked");
    const pending = createHandleRelativeStorage(unknownRoot, backend);
    assert.equal(await pending.native.acquire(unknownRoot), false);
    assert.equal(await pending.native.writersStopped(unknownRoot), false);
    const exportExited = once(exporter, "exit");
    exporter.kill();
    await exportExited;
    children.delete(exporter);
    const noKeys = {
      available: async () => false,
      wrap: async () => {
        throw new Error("unavailable");
      },
      unwrap: async () => {
        throw new Error("unavailable");
      },
    };
    const unknownDisk = new NodeRecoveryDisk({
      root: unknownRoot,
      native: pending.native,
      files: pending.files,
      keys: noKeys,
    });
    // Real shipping capture gate remains false; cleanup/acknowledgment still has
    // to settle metadata without decrypting history or implicitly starting capture.
    const unknownController = new RecoveryController({
      disk: unknownDisk,
      clock,
      chooseDestination: async () => undefined,
    });
    try {
      await unknownController.initialize();
      const id = unknownController.status().unknownOperation;
      assert.ok(id);
      assert.equal((await unknownController.preparePreview("current")).ok, false);
      value(await unknownController.acknowledgeUnknown(id));
      assert.equal(unknownController.status().acknowledgedUnknown, true);
      assert.equal(unknownController.status().lastSaveOutcome, undefined);
      await assert.rejects(pending.files.lstat(join(unknownRoot, "export-stage.tmp")), { code: "ENOENT" });
      await assert.rejects(readFile(join(base, "unpublished.json")), { code: "ENOENT" });
      value(await unknownController.setEnabled(false, 1));
      assert.equal(unknownController.status().acknowledgedUnknown, false);
      assert.ok(!(await readdir(unknownRoot)).some((name) => name.startsWith("export")));
      cases.interruptedExportWriterFenceAndKeyIndependentUnknownCleanup = true;
    } finally {
      await unknownController.cleanExit();
      await unknownDisk.waitForSettlement();
      await pending.close();
    }
    const binaries: Record<string, string> = {};
    for (const name of ["diagnostics_clock.node", "diagnostics_storage.node"])
      binaries[name] = createHash("sha256")
        .update(await readFile(join(nativeDirectory, name)))
        .digest("hex");
    process.stdout.write(
      JSON.stringify({
        schema: 1,
        platform: "win32",
        arch: process.arch,
        runtime: process.versions.node,
        cases,
        binaries,
        keys: "synthetic-fixture-only; current-user DPAPI separately verified",
        physicalSuspendReboot: "unrun",
        powerLoss: "unrun",
        differentUser: "unrun",
      }) + "\n",
    );
  } finally {
    for (const process of children) {
      const exited = once(process, "exit");
      process.kill();
      await exited;
    }
    await storage.close().catch(() => undefined);
    await other.close().catch(() => undefined);
    assert.equal(dirname(base), parent);
    await rm(base, { recursive: true, force: true });
  }
}
