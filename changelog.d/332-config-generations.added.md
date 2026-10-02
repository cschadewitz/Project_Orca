- **engine/daemon:** Add configuration generations, redacted launch provenance and explicit
  apply contracts, with the reserved runtime wiring supplied as an integration patch.
  Saved revisions remain distinct from active generations; a pinned workflow body is immutable.
  Preserve effective plugin registrations within their bootstrap lifetime, and restore
  plugin-bound runs after restart only when the plugin entry digests, plugin list, hosts
  and provider match, failing closed otherwise. Retain admitted configured gate behavior, and reject
  removal of configured workflow defaults. A separate trusted capture seam supports
  recovery of an original Request admission without weakening fresh-launch guards.
