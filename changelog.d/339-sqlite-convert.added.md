- **store:** `orca store sqlite convert` converts a workspace's file store into a SQLite store of
  its own beside it (`.orca-sqlite`) and names it in the workspace's existing config, leaving the
  file store exactly as it was. ORCA 0.7.0 and earlier refuse the new store, checked against the
  released v0.7.0 and v0.6.0 in CI. One that was already running keeps the file store, and
  `orca store format` reports anything it writes there afterwards. Refused on Windows (#947) and
  for the desktop app's own workspaces; `orca store sqlite switch` (in place) stays refused (#339).
