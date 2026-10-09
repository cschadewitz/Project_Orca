/** Preserve retained continuations after ownership reconciliation; execution needs explicit operator action. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
export function firstRunRequiresExplicitContinuationRecovery(configDir: string): boolean {
  try {
    const names = readdirSync(join(configDir, ".orca-first-run-ownership"));
    if (names.length >= 256) return true;
    return names.some((name) =>
      readdirSync(join(configDir, ".orca-first-run-ownership", name)).includes("recovery.json"),
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    return true;
  }
}
