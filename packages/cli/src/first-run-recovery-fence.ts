/** Pending first-run recovery fences all bootstrap writers, including direct CLI/ACP routes. */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { OrcaError } from "@orca/core";
const refuse = (): never => {
  throw new OrcaError(
    "CONFIG_INVALID",
    "First-run machine-restart recovery is pending. Preserve the ownership journal; reconcile in the app before starting another writer.",
  );
};
export function assertNoPendingFirstRunRecovery(...paths: string[]): void {
  for (const input of paths) {
    let path = resolve(input);
    let budget = 256;
    while (budget-- > 0) {
      const journal = join(path, ".orca-first-run-ownership");
      let found = false;
      try {
        lstatSync(journal);
        found = true;
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
          return refuse();
        try {
          lstatSync(join(path, ".orca-first-run-ownership.json"));
          return refuse();
        } catch (anchorError) {
          if (!(
            typeof anchorError === "object" &&
            anchorError !== null &&
            "code" in anchorError &&
            anchorError.code === "ENOENT"
          ))
            return refuse();
        }
      }
      if (found)
        try {
          const info = lstatSync(journal);
          if (!info.isDirectory() || info.isSymbolicLink()) return refuse();
          const names = readdirSync(journal).sort();
          if (names.length >= 256 || names.some((name, i) => name !== String(i + 1).padStart(6, "0"))) return refuse();
          const latest = names.at(-1);
          if (latest) {
            const attempt = join(journal, latest);
            const record = lstatSync(attempt);
            if (!record.isDirectory() || record.isSymbolicLink()) return refuse();
            // Even a resolved attempt waits for app-owned reservation of the next generation.
            if (readdirSync(attempt).some((name) => name === "recovery-request.json" || name === "recovery.json"))
              return refuse();
          }
        } catch {
          return refuse();
        }
      try {
        const canonical = realpathSync(path);
        if (canonical !== path) {
          path = canonical;
          continue;
        }
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
      }
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
    if (budget < 0) return refuse();
  }
}

/** Reconciled stores retain work for explicit operator continuation; startup must never replay it. */
export function firstRunRequiresExplicitContinuationRecovery(configDir: string): boolean {
  const journal = join(configDir, ".orca-first-run-ownership");
  try {
    const names = readdirSync(journal);
    if (names.length >= 256) return true;
    return names.some((name) => readdirSync(join(journal, name)).includes("recovery.json"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    return true;
  }
}
