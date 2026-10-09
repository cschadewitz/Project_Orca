/** Self-contained current-user DPAPI wrappers; Electron Local State is legacy read authority only. */
import { loadDiagnosticsAddon } from "./native-addon.js";
import type { DiagnosticsKeyAdapter } from "./native-adapter.js";

const prefix = Buffer.from("ORCADP01", "ascii");
interface WindowsKeyProtection {
  protectKey(value: Buffer): Promise<Buffer>;
  unprotectKey(value: Buffer): Promise<Buffer>;
}
const unavailable = () => new Error("unavailable");

export function loadWindowsDiagnosticsKeyAdapter(legacy: DiagnosticsKeyAdapter): DiagnosticsKeyAdapter {
  return createWindowsDiagnosticsKeyAdapter(loadDiagnosticsAddon("diagnostics_storage"), legacy);
}

/** Injection is for bounded native conformance only; production has one fixed addon location. */
export function createWindowsDiagnosticsKeyAdapter(
  source: unknown,
  legacy: DiagnosticsKeyAdapter,
): DiagnosticsKeyAdapter {
  const property = (name: string): unknown =>
    source && typeof source === "object" ? Object.getOwnPropertyDescriptor(source, name)?.value : undefined;
  const backend =
    property("abi") === 1 &&
    property("platform") === "win32" &&
    property("keyProtection") === 1 &&
    typeof property("protectKey") === "function" &&
    typeof property("unprotectKey") === "function"
      ? (source as WindowsKeyProtection)
      : undefined;
  return {
    available: () => Promise.resolve(backend !== undefined),
    async wrap(bytes) {
      if (!backend || bytes.length !== 32) throw unavailable();
      const protectedBytes = await backend.protectKey(bytes);
      try {
        if (!Buffer.isBuffer(protectedBytes) || protectedBytes.length <= 32 || protectedBytes.length > 4088)
          throw unavailable();
        return Buffer.concat([prefix, protectedBytes]);
      } finally {
        if (Buffer.isBuffer(protectedBytes)) protectedBytes.fill(0);
      }
    },
    async unwrap(bytes) {
      if (!backend || bytes.length <= 32 || bytes.length > 4096) throw unavailable();
      let recovered: Buffer;
      if (bytes.subarray(0, prefix.length).equals(prefix)) {
        // A native refusal is final. Never reinterpret damaged new wrappers as legacy data.
        recovered = await backend.unprotectKey(bytes.subarray(prefix.length));
      } else if (bytes.subarray(0, 3).equals(Buffer.from("v10"))) {
        // Preserve existing profile authority, including its rotation/unavailability refusal.
        recovered = await legacy.unwrap(bytes);
      } else throw unavailable();
      if (!Buffer.isBuffer(recovered) || recovered.length !== 32) {
        if (Buffer.isBuffer(recovered)) recovered.fill(0);
        throw unavailable();
      }
      return recovered;
    },
  };
}
