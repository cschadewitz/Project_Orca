/** Combined native journal and participating-writer bootstrap, synchronously closed. */
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import {
  enterUpdateWriter,
  updateAdmissionOpen,
  updateExistingWorkAllowed,
  inspectUpdateWindowRoots,
  type UpdateWriterLease,
} from "@orca/protocol/update-window";
import { createNativeMacReplacementStartup } from "./mac-replacement-startup.js";
import { provisionMacUpdateNamespace, enrollMacUpdateRoots } from "./mac-update-namespace.js";

/** The main owner supplies its complete captured configured root set before producers.
 * Control is a private sibling outside the unchanged live paths. Unknown enrollment,
 * old journal attempts, closed windows and changed root sets open only a recovery shell.
 * This constructor supplies no signing, continuity, installation or root inventory proof. */
export function createManagedMacReplacementStartup(options: {
  control: string;
  appRoot: string;
  safeStorage: Parameters<typeof createNativeMacReplacementStartup>[0]["safeStorage"];
}) {
  const native = createNativeMacReplacementStartup({
    root: join(options.control, "journal"),
    safeStorage: options.safeStorage,
  });
  let lease: UpdateWriterLease | undefined,
    sealed = false,
    ordinary = false;
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
  return {
    bootstrap,
    journal: native.journal,
    /** Serialized before first-run config creation or a newly owned daemon bootstrap. */
    async enrollProtectedRoots(roots: readonly string[]): Promise<void> {
      if (!bootstrap.ordinaryAllowed) throw new Error("Protected startup is closed");
      await enrollMacUpdateRoots(options.control, roots);
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
          if (!established) await provisionMacUpdateNamespace(options.control, protectedRoots);
          const enrolled = inspectUpdateWindowRoots(options.control);
          if (!protectedRoots.every((root) => enrolled.roots.some((captured) => captured.path === root)))
            return "unknown";
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
