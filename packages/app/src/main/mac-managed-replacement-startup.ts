/** Combined native journal and participating-writer bootstrap, synchronously closed. */
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import {
  enterUpdateWriter,
  updateAdmissionOpen,
  updateExistingWorkAllowed,
  inspectUpdateWindowRoots,
  type UpdateWindowState,
  type UpdateWriterLease,
} from "@orca/protocol/update-window";
import { createMacReplacementStartup, createNativeMacReplacementStartup } from "./mac-replacement-startup.js";
import {
  provisionMacUpdateNamespace,
  enrollMacUpdateRoots,
  reanchorMacUpdateNamespace,
  macUpdateNamespaceResettable,
  resetMacUpdateNamespace,
} from "./mac-update-namespace.js";
import type { NativeStorageBackend } from "./diagnostics/native-storage.js";

/** The main owner supplies its complete captured configured root set before producers.
 * Control is a private sibling outside the unchanged live paths. Unknown enrollment,
 * old journal attempts, closed windows and changed root sets open only a recovery shell.
 * An open window no attempt holds is re-anchored instead after its directories moved.
 * This constructor supplies no signing, continuity, installation or root inventory proof. */
export function createManagedMacReplacementStartup(options: {
  control: string;
  appRoot: string;
  safeStorage: Parameters<typeof createNativeMacReplacementStartup>[0]["safeStorage"];
  /** Conformance only: a compiled or synthetic backend and journal storage in place of the
   * packaged Darwin ones. Production passes neither. */
  fixture?: {
    backend: NativeStorageBackend;
    journal: Parameters<typeof createMacReplacementStartup>[1];
  };
}) {
  const native = options.fixture
    ? createMacReplacementStartup(join(options.control, "journal"), options.fixture.journal)
    : createNativeMacReplacementStartup({
        root: join(options.control, "journal"),
        safeStorage: options.safeStorage,
      });
  const backend = options.fixture?.backend;
  let lease: UpdateWriterLease | undefined,
    sealed = false,
    ordinary = false,
    resettable = false;
  let operation: Promise<"ordinary" | "closed" | "unknown"> | undefined;
  const bootstrap = {
    get existingWorkAllowed() {
      return (
        !sealed &&
        ordinary &&
        lease?.check() === true &&
        updateExistingWorkAllowed(options.appRoot) &&
        native.bootstrap.ordinaryAllowed
      );
    },
    get ordinaryAllowed() {
      return (
        !sealed &&
        ordinary &&
        lease?.check() === true &&
        updateAdmissionOpen(options.appRoot) &&
        native.bootstrap.ordinaryAllowed
      );
    },
    seal() {
      sealed = true;
      ordinary = false;
      native.bootstrap.seal();
    },
  };
  /** Provision on first launch, then inspect. A window that does not inspect cleanly is
   * re-anchored only while open and unused by any attempt; otherwise this throws. */
  async function enrolledWindow(established: boolean, roots: readonly string[]): Promise<UpdateWindowState> {
    try {
      if (!established) await provisionMacUpdateNamespace(options.control, roots, backend);
      const enrolled = inspectUpdateWindowRoots(options.control);
      if (roots.every((root) => enrolled.roots.some((captured) => captured.path === root))) return enrolled;
    } catch {
      // Re-anchored below when that is provably safe, or refused there.
    }
    return reanchorMacUpdateNamespace(options.control, roots, backend);
  }
  return {
    bootstrap,
    journal: native.journal,
    /** After an "unknown" startup: the window's records are lost or unreadable and record no
     * attempt, so the person may confirm a reset. Never set for a busy or closed window. */
    get resettable() {
      return resettable;
    },
    /** Serialized before first-run config creation or a newly owned daemon bootstrap. */
    async enrollProtectedRoots(roots: readonly string[]): Promise<void> {
      if (!bootstrap.ordinaryAllowed) throw new Error("Protected startup is closed");
      await enrollMacUpdateRoots(options.control, roots, backend);
      if (!bootstrap.ordinaryAllowed) throw new Error("Protected root enrollment did not settle");
    },
    initialize(protectedRoots: readonly string[]): Promise<"ordinary" | "closed" | "unknown"> {
      return (operation ??= Promise.resolve().then(async () => {
        try {
          if (sealed || !protectedRoots.includes(options.appRoot)) return "unknown";
          // Older records bind their encryption AAD to the original path. Never move,
          // ignore or reprovision that namespace under this new closed-window owner.
          try {
            await lstat(join(options.appRoot, "native-replacement"));
            return "closed";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          // An established closed window must be inspected, never re-provisioned as empty.
          let established = false;
          try {
            await lstat(join(options.control, "enrolled.json"));
            established = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          let enrolled: UpdateWindowState;
          try {
            enrolled = await enrolledWindow(established, protectedRoots);
          } catch (error) {
            resettable = await macUpdateNamespaceResettable(options.control, protectedRoots);
            throw error;
          }
          if (enrolled.phase !== "open") return "closed";
          const decision = await native.bootstrap.inspect();
          if (decision.outcome !== "ordinary") return decision.outcome === "replacement-closed" ? "closed" : "unknown";
          lease = await enterUpdateWriter(options.appRoot);
          if (sealed || !lease?.check()) return "unknown";
          ordinary = true;
          return "ordinary";
        } catch {
          bootstrap.seal();
          return "unknown";
        }
      }));
    },
    /** The person confirmed a reset offered by `resettable`. Startup stays closed in this
     * process; the caller relaunches, and the next launch provisions as on first launch. */
    async reset(): Promise<boolean> {
      if (!resettable || !operation || (await operation) !== "unknown") return false;
      resettable = false;
      try {
        await resetMacUpdateNamespace(options.control, [options.appRoot]);
        return true;
      } catch {
        return false;
      }
    },
    /** Call after the main owner has fully drained all app writers under its final freeze. */
    async releasePausedAppWriter() {
      bootstrap.seal();
      await lease?.close();
    },
    async close() {
      bootstrap.seal();
      await lease?.close();
      await native.close();
    },
  };
}
