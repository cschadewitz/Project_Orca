/** Mount the actual native encrypted updater journal before ordinary app producers. */
import { createSafeStorageKeyAdapter } from "./diagnostics/native-adapter.js";
import {
  MacReplacementJournal,
  type MacReplacementStorage,
  type MacReplacementRecord,
} from "./mac-replacement-journal.js";
import { MacReplacementBootstrap } from "./mac-replacement-recovery.js";
import { loadNativeMacReplacementStorage } from "./mac-replacement-storage.js";

/** Explicit storage injection is for journal conformance; it supplies no writer/restore
 * authority. The native constructor below fixes production storage and key adapters. */
export function createMacReplacementStartup(root: string, storage: MacReplacementStorage & { close(): Promise<void> }) {
  const disk = new MacReplacementJournal(root, storage);
  const read = () => disk.read();
  const bootstrap = new MacReplacementBootstrap({ read });
  return {
    bootstrap,
    journal: {
      read,
      commit(record: MacReplacementRecord): Promise<void> {
        bootstrap.seal();
        return disk.commit(record);
      },
    },
    async close(): Promise<void> {
      bootstrap.seal();
      try {
        await disk.close();
      } finally {
        // Release held descriptors even if the pathname/lock identity was replaced.
        // Native closeRoot waits for settlement and never follows the replacement path.
        await storage.close();
      }
    },
  };
}

/** Does not inspect before app readiness or enable installation. Bootstrap is closed
 * immediately; the caller must await inspect before entering any ordinary producer. */
export function createNativeMacReplacementStartup(options: {
  root: string;
  safeStorage: Parameters<typeof createSafeStorageKeyAdapter>[0];
}) {
  const storage = loadNativeMacReplacementStorage(options.root);
  return createMacReplacementStartup(options.root, {
    ...storage,
    // Mac replacement keys are macOS keychain keys. The adapter's default platform would
    // also accept Windows' safeStorage, so anywhere else the keys stay unavailable.
    keys: createSafeStorageKeyAdapter(options.safeStorage, process.platform === "darwin" ? "darwin" : "unsupported"),
  });
}
