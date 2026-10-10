/** Concrete updater journal storage, using the packaged handle-relative native backend. */
import { loadDiagnosticsAddon } from "./diagnostics/native-addon.js";
import { createProductionNativeAdapter } from "./diagnostics/native-adapter.js";
import {
  createHandleRelativeStorage,
  type NativeDiagnosticsStorage,
  type NativeStorageBackend,
} from "./diagnostics/native-storage.js";

const unavailable = () => Promise.reject(new Error("Replacement recovery unavailable"));

/** Separate root and whitelist. An older diagnostics addon cannot silently supply recovery.
 * Linux is available only via explicit conformance injection, never this production loader. */
export function loadNativeMacReplacementStorage(root: string): NativeDiagnosticsStorage {
  if (process.platform === "darwin") {
    try {
      const backend = loadDiagnosticsAddon("diagnostics_storage");
      const property = (name: string): unknown => Object.getOwnPropertyDescriptor(backend, name)?.value;
      if (
        property("abi") === 1 &&
        property("platform") === "darwin" &&
        property("replacementStorage") === 1 &&
        typeof property("call") === "function"
      )
        return createHandleRelativeStorage(root, backend as NativeStorageBackend, "replacement");
    } catch {
      /* Missing, stale or incompatible native resources retain closed bootstrap. */
    }
  }
  return {
    native: createProductionNativeAdapter(),
    files: { lstat: unavailable, readdir: unavailable, open: unavailable },
    close: () => Promise.resolve(),
  };
}
