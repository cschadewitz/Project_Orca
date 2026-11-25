/** Preserve retained continuations after ownership reconciliation; execution needs explicit operator action. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
/**
 * The journal's names: this version's and, until 0.10, the one from before the rename to Orrery,
 * since a journal written then still holds work that must stay parked. The same name until the
 * codemod runs.
 */
const JOURNALS = [
  ...new Set([
    ".orca-first-run-ownership",
    ".orca-first-run-ownership", // rename-keep: pre-rename journal, read until 0.10
  ]),
];

export function firstRunRequiresExplicitContinuationRecovery(configDir: string): boolean {
  return JOURNALS.some((name) => journalRequiresRecovery(join(configDir, name)));
}

function journalRequiresRecovery(journal: string): boolean {
  try {
    const names = readdirSync(journal);
    if (names.length >= 256) return true;
    return names.some((name) => {
      if (/^[0-9]{6}$/.test(name)) {
        // A same-boot reconciliation or a person-confirmed end after a restart: neither is clean work completion.
        const records = readdirSync(join(journal, name));
        return records.includes("recovery.json") || records.includes("ended-after-reboot.json");
      }
      // A checkpoint carries whether any attempt it folded away had been settled either way.
      if (/^checkpoint-[0-9]{6}\.json$/.test(name))
        return (JSON.parse(readFileSync(join(journal, name), "utf8")) as { recovered?: unknown }).recovered !== false;
      // Other compaction state never holds an unfolded resolution; an unknown entry keeps work parked.
      return !/^(?:checkpoint-[0-9]{6}\.pending|discarded-[0-9]{6})$/.test(name);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    return true;
  }
}
