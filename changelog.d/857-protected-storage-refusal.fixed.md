- **app:** a refused protected-storage key is now a specific, actionable state in guided
  launch instead of a generic error. Cancelling or ignoring the Linux keyring unlock prompt,
  a locked keyring, a session with only `basic_text` storage and an unavailable OS keychain
  each name their cause, say what to do (unlock, retry, or quit and reopen), and offer
  Retry launch with the same reviewed command. Nothing is submitted and there is still no
  plain-text fallback. A launch the daemon accepted before storage refused its receipt
  stays on the recover path instead of being offered again.
