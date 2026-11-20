- **app:** a refused protected-storage key is now a specific, actionable state in guided
  launch instead of a generic error. Cancelling or ignoring the Linux keyring unlock prompt,
  a locked keyring, a session with only `basic_text` storage and an unavailable OS keychain
  each name their cause and say what to do. On Linux that is quit and reopen ORCA and accept
  the unlock prompt, because the keyring is asked only once per app start; an unavailable OS
  keychain offers Retry launch with the same reviewed command. Nothing is submitted and there
  is still no plain-text fallback. A launch the daemon accepted before storage refused its
  receipt, or one that may already be retained, stays on the recover path until ORCA has read
  its retained launches.
