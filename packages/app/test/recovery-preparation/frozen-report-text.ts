/** Test-only main-byte oracle. No renderer/preload report-content API exists. */
import { createHash } from "node:crypto";
import type { RecoveryController } from "../../src/main/diagnostics/recovery-controller.js";
import type { DiagnosticExport } from "../../src/diagnostics-contract.js";

export function frozenReportText(controller: RecoveryController, report: DiagnosticExport) {
  const owned = (controller as unknown as { preparedReport?: { handle: string; bytes: Buffer } }).preparedReport;
  if (
    !owned ||
    owned.handle !== report.handle ||
    owned.bytes.length !== report.byteLength ||
    createHash("sha256").update(owned.bytes).digest("hex") !== report.sha256
  )
    throw new Error("stale_export");
  return Promise.resolve({ ...report, text: owned.bytes.toString("utf8") });
}
