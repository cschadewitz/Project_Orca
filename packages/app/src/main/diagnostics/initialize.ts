/** Main-owned composition only. IPC/window/power/lifecycle registration belongs to callers. */
import { ControlledPayloadMemory } from "./payload-memory.js";
import { RecoveryController } from "./recovery-controller.js";
import { NodeRecoveryDisk } from "./recovery-disk.js";
import { createSafeStorageKeyAdapter } from "./native-adapter.js";
import { loadWindowsDiagnosticsKeyAdapter } from "./windows-key-adapter.js";
import { loadNativeDiagnosticsClock } from "./native-clock.js";
import { loadNativeDiagnosticsStorage } from "./native-storage.js";
import { startupDiagnosticObserver } from "./startup-producer.js";
import { ownedDiagnosticObserver } from "./source-producers.js";

export interface DiagnosticsInitializerOptions {
  root: string;
  safeStorage: Parameters<typeof createSafeStorageKeyAdapter>[0];
  chooseDestination: () => Promise<string | undefined>;
}

/** Call initialize after app readiness. No injectable production-enablement option. */
export function createDiagnosticsInitializer(options: DiagnosticsInitializerOptions) {
  const payload = new ControlledPayloadMemory();
  const storage = loadNativeDiagnosticsStorage(options.root);
  const legacyKeys = createSafeStorageKeyAdapter(options.safeStorage);
  const disk = new NodeRecoveryDisk({
    payload,
    root: options.root,
    keys: process.platform === "win32" ? loadWindowsDiagnosticsKeyAdapter(legacyKeys) : legacyKeys,
    native: storage.native,
    files: storage.files,
  });
  const controller = new RecoveryController({
    disk,
    payload,
    clock: loadNativeDiagnosticsClock(),
    chooseDestination: options.chooseDestination,
  });
  return {
    controller,
    startupObserver: startupDiagnosticObserver(controller),
    observer: ownedDiagnosticObserver(controller),
    initialize: () => controller.initialize(),
    async close() {
      await controller.cleanExit();
      await disk.waitForSettlement();
      await storage.close();
    },
  };
}
