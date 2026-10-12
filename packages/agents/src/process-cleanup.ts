/** Bounded, shared termination of one owned agent process handle. */
import { describeError, OrcaError } from "@orca/core";
import type { AgentProcessHandle } from "./host.js";

/** Each signal gets at most two seconds to produce an observed direct-child exit. */
const EXIT_GRACE_MS = 2000;

/**
 * Only this live handle is owned. No descendant or remote-process exit is implied.
 * `graceMs` replaces the per-signal wait; production leaves it at `EXIT_GRACE_MS`.
 */
export function processCleanup(proc: AgentProcessHandle, graceMs: number = EXIT_GRACE_MS): () => Promise<void> {
  let exited = false;
  const exit = proc.exited.then(() => {
    exited = true;
  });
  // A faulty custom handle can reject; cleanup still attempts both signals.
  void exit.catch(() => undefined);
  let cleanup: Promise<void> | undefined;

  const waitForExit = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exit.then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), graceMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  return () => {
    cleanup ??= (async () => {
      // Observe an already-settled exit before sending anything.
      await Promise.resolve();
      const signalErrors: unknown[] = [];
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (exited) return;
        try {
          proc.kill(signal);
        } catch (error) {
          signalErrors.push({ signal, error: describeError(error) });
        }
        if (await waitForExit()) return;
      }
      throw new OrcaError("AGENT_TRANSPORT", "agent cleanup incomplete: direct-child exit was not observed", {
        cleanupIncomplete: true,
        signalErrors,
      });
    })();
    return cleanup;
  };
}
