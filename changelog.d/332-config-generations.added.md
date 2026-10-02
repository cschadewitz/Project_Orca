- **engine/daemon:** Add integrated configuration generations, launch provenance and
  explicit apply. Saved revisions remain distinct from active generations and pinned
  workflow bodies remain immutable. Custom executable plugin registrations bind the
  entire generation to its original engine bootstrap, including workflows that never
  use them; restarting that engine process can prevent restoration. No-op/declarative
  plugins retain conditional restart compatibility. Cross-process custom-plugin
  restoration is tracked in #394–396. Boot preserves unrelated recovery after unused workflow edits, configured literal
  redaction distinguishes ordinary arguments from credentials, and restoration checks
  reject incompatible executable plugins in both directions.
