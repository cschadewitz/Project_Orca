- **docs:** the plain-language rule judge and Codex's experimental hook are now described
  separately. Opting Codex in to `nativeToolHook: experimental` does not make the judge available
  there: on the hook route a call ORCA would ask about is blocked, so no ask or judge advice is
  shown, and in Codex's default adapter mode Codex's own review (not ORCA's judge) decides its
  approval requests. ORCA has not verified the judge for Codex in this version.
