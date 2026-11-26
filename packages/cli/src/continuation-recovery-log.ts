/**
 * The daemon retries continuation recovery every 5 s. Before #1197 every failed tick logged
 * the same "requires explicit attention" line and dropped the reason. This logs once per change
 * of state instead: the first failure with its code and message, nothing while the same failure
 * repeats, a new line if the reason changes, and one line when a later tick passes again.
 */
import type { Logger } from "@orca/core";

function reasonOf(error: unknown): { code: string; message: string } {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

export function continuationRecoveryLog(logger: Pick<Logger, "warn" | "info">): {
  passed(): void;
  failed(error: unknown): void;
} {
  let last: string | undefined;
  return {
    passed() {
      if (last === undefined) return;
      last = undefined;
      logger.info("Continuation recovery is running again");
    },
    failed(error) {
      const reason = reasonOf(error);
      const key = `${reason.code}\n${reason.message}`;
      if (key === last) return;
      last = key;
      logger.warn("Continuation recovery could not run; retrying every 5 s", {
        ...reason,
        ...(reason.code === "STORE_LOCK_TIMEOUT" ? { help: "docs/storage/file-locks.md" } : {}),
      });
    },
  };
}
