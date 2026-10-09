/** Closed diagnostics wording; native failures never supply visible exception text. */
import type { DiagnosticResultCode } from "../../../src/diagnostics-contract.js";

/** Closed copy only: a native exception, report or path cannot become a status message. */
export const DIAGNOSTICS_MESSAGES: Record<DiagnosticResultCode, string> = {
  off: "Local diagnostics are off.",
  ready: "Local diagnostics are available.",
  export_ready: "Report prepared. Choose a destination, then Save to export it.",
  cancelled: "Destination selection was cancelled. No file was saved. Choose a destination to try again.",
  unavailable: "Local diagnostics are unavailable. Ordinary app work can continue.",
  age_uncertain: "The age of retained history cannot be verified. Recovery is unavailable.",
  expired: "This diagnostic history has expired. Choose Export again for available history.",
  capacity_limited: "Size limits have reduced the retained history.",
  stale_export: "This prepared report is no longer available. Choose Export again to prepare a fresh report.",
  publication_pending: "Save is pending. ORCA cannot yet confirm whether a file was saved.",
  saved: "The prepared report was saved locally. ORCA will not remove that exported file.",
  refused: "This diagnostics action was refused. Review the current status before trying again.",
  cleanup_pending: "Some local diagnostic files or key material could not be removed. Cleanup is pending.",
  unknown_blocked:
    "The earlier Save outcome is unknown. Work or safe cleanup remains unresolved; saving again is blocked.",
  unknown_ready:
    "The earlier Save outcome remains unknown. Safe cleanup is complete; acknowledgement is required before saving again.",
  acknowledged_unknown:
    "The earlier unknown Save outcome was acknowledged. A fresh report, destination and separate Save are required.",
};

export const EARLIER_EXPORT_WARNING =
  "The earlier export may already exist. ORCA cannot confirm its result and will not find, change or delete that file. After safe cleanup, you can acknowledge the unknown result and choose to save again.";

export const SAVE_WARNING =
  "Save the prepared report to the location shown? The file will be unencrypted. Other people or software with access to this location may read or sync it. ORCA will not automatically delete files you save.";
