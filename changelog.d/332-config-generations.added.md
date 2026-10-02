- **engine/daemon:** Add configuration generations, redacted launch provenance and explicit
  apply contracts, with the reserved runtime wiring supplied as an integration patch.
  Saved revisions remain distinct from active generations; a pinned workflow body is immutable.
  Preserve effective plugin registrations within their bootstrap lifetime, fail closed on
  unsupported plugin restoration, retain admitted configured gate behavior, and reject
  removal of configured workflow defaults. A separate trusted capture seam supports
  recovery of an original Request admission without weakening fresh-launch guards.
