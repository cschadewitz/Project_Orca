/** Main-owned composition only. IPC/window/power/lifecycle registration belongs to callers. */
import { RecoveryController } from "./recovery-controller.js";
import { NodeRecoveryDisk } from "./recovery-disk.js";
import { createSafeStorageKeyAdapter } from "./native-adapter.js";
import { loadNativeDiagnosticsClock } from "./native-clock.js";
import { loadNativeDiagnosticsStorage } from "./native-storage.js";
import { startupDiagnosticObserver } from "./startup-producer.js";

export interface DiagnosticsInitializerOptions {
  root: string;
  safeStorage: Parameters<typeof createSafeStorageKeyAdapter>[0];
  chooseDestination: () => Promise<string | undefined>;
}

/** Call initialize after app readiness. No injectable production-enablement option. */
export function createDiagnosticsInitializer(options: DiagnosticsInitializerOptions) {
  const storage = loadNativeDiagnosticsStorage(options.root);
  const disk = new NodeRecoveryDisk({
    root: options.root,
    keys: createSafeStorageKeyAdapter(options.safeStorage),
    native: storage.native,
    files: storage.files,
  });
  const controller = new RecoveryController({
    disk,
    clock: loadNativeDiagnosticsClock(),
    chooseDestination: options.chooseDestination,
  });
  return {
    controller,
    startupObserver: startupDiagnosticObserver(controller),
    initialize: () => controller.initialize(),
    async close() {
      await controller.cleanExit();
      await disk.waitForSettlement();
      await storage.close();
    },
  };
}
