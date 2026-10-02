- **engine/daemon:** Add integrated configuration generations, launch provenance and
  explicit apply. Saved revisions remain distinct from active generations and pinned
  workflow bodies remain immutable. Custom executable plugin registrations bind the
  entire generation to its original engine bootstrap, including workflows that never
  use them; restarting that engine process can prevent restoration. No-op/declarative
  plugins retain conditional restart compatibility. Cross-process custom-plugin
  restoration is tracked in #394–396. Review findings on startup collisions, redaction
  and the reverse-direction plugin restoration gap remain unresolved at `27411de9`.
