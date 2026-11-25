- **docs:** the Codex IPC caveat is now stated where you opt Codex in to `nativeToolHook:
  experimental`, before you enable it. The hook decides which commands run, not what an allowed
  command connects to on the same machine. ORCA has not verified that Codex's sandbox isolates
  those endpoints. Until now the caveat was stated only in the warning logged after the session
  started.
