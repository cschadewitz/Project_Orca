/** Private recovery clock. Native capability is not consent or platform acceptance. */
import { loadDiagnosticsAddon } from "./native-addon.js";
import type { BootReading, DiagnosticsClock } from "./recovery-contract.js";

const unavailable: DiagnosticsClock = Object.freeze({ read: () => undefined });

/** Fixed local addon only; absent, incompatible and unsupported builds fail closed. */
export function loadNativeDiagnosticsClock(): DiagnosticsClock {
  if (process.platform !== "darwin") return unavailable;
  try {
    return createNativeDiagnosticsClock(loadDiagnosticsAddon("diagnostics_clock"));
  } catch {
    return unavailable;
  }
}

/** Injectable conformance seam. Shipping callers use the fixed loader above. */
export function createNativeDiagnosticsClock(backend: unknown, platform: string = process.platform): DiagnosticsClock {
  if (platform !== "darwin") return unavailable;
  let read: () => unknown;
  try {
    if (
      data(backend, "abi") !== 1 ||
      data(backend, "platform") !== "darwin" ||
      data(backend, "suspendInclusive") !== true
    )
      return unavailable;
    const candidate = data(backend, "read");
    if (typeof candidate !== "function") return unavailable;
    read = candidate as () => unknown;
  } catch {
    return unavailable;
  }
  let last: BootReading | undefined;
  let uncertain = false;
  return {
    read() {
      if (uncertain) return undefined;
      try {
        const observation = read();
        const bootId = data(observation, "bootId");
        const elapsedMs = data(observation, "elapsedMs");
        if (
          typeof bootId !== "string" ||
          bootId.length !== 36 ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootId) ||
          typeof elapsedMs !== "number" ||
          !Number.isSafeInteger(elapsedMs) ||
          elapsedMs < 0 ||
          (last && (bootId !== last.bootId || elapsedMs < last.elapsedMs))
        ) {
          uncertain = true;
          return undefined;
        }
        // Never retain the native object or return mutable continuity authority.
        last = { bootId, elapsedMs };
        return { ...last };
      } catch {
        uncertain = true;
        return undefined;
      }
    },
  };
}

/** Fixed own data fields only: no getters, coercion, traversal or serialization. */
function data(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? (descriptor.value as unknown) : undefined;
}
