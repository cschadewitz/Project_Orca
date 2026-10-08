/** Explicit disposable Node-API/controller probe. Synthetic keys/clock are not native acceptance. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandleRelativeStorage, type NativeStorageBackend } from "../../src/main/diagnostics/native-storage.js";
import { NodeRecoveryDisk } from "../../src/main/diagnostics/recovery-disk.js";
import { RecoveryController } from "../../src/main/diagnostics/recovery-controller.js";
import { startupDiagnosticObserver } from "../../src/main/diagnostics/startup-producer.js";
import { SyntheticKeys, value } from "./implementation-fixture.js";

const backend = createRequire(import.meta.url)(
  "../../native/diagnostics/build/Release/diagnostics_storage.node",
) as NativeStorageBackend;
assert.equal(backend.abi, 1);
assert.equal(backend.platform, process.platform === "darwin" ? "darwin" : "posix-fixture");
await assert.rejects(backend.call("rootStat", {}, undefined, "", "", undefined, 0, 0, 0), /unavailable/);
const directory = await mkdtemp(join(process.argv[2] ?? tmpdir(), "orca-native-node-probe-"));
const root = join(directory, "private");
const storage = createHandleRelativeStorage(root, backend);
const second = createHandleRelativeStorage(root, backend);
const disk = new NodeRecoveryDisk({ root, native: storage.native, files: storage.files, keys: new SyntheticKeys() });
const boot = { bootId: "synthetic-clock", elapsedMs: 1000 };
const destination = join(directory, "report.json");
const controller = new RecoveryController({
  disk,
  clock: { read: () => ({ ...boot }) },
  productionEnabled: true,
  chooseDestination: () => Promise.resolve(destination),
});
try {
  await controller.initialize();
  value(await controller.setEnabled(true, 1));
  assert.equal(await second.native.acquire(root), false);
  startupDiagnosticObserver(controller)("startup_spawn_failed");
  await controller.checkpoint();
  const preview = value(await controller.preparePreview("current"));
  assert.ok(preview.text.includes("startup_spawn_failed"));
  assert.ok(!preview.text.includes(directory));
  assert.ok(!preview.text.includes(boot.bootId));
  const selected = value(await controller.chooseDestination(preview.handle));
  const saved = value(await controller.save(preview.handle, selected.token));
  assert.equal(saved.lastSaveOutcome, "saved");
  assert.equal(await readFile(destination, "utf8"), preview.text);
  await controller.cleanExit();
  await disk.waitForSettlement();
  await storage.close();
  assert.equal(await second.native.acquire(root), true);
  await second.native.release(root);
  process.stdout.write(
    "Disposable Node-API/controller checkpoint, exact Save, writer exclusion/release passed; synthetic keys/clock\n",
  );
} finally {
  await controller.cleanExit().catch(() => undefined);
  await disk.waitForSettlement();
  await storage.close().catch(() => undefined);
  await second.close();
  await rm(directory, { recursive: true, force: true });
}
