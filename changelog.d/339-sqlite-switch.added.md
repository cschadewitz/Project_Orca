- **store:** `orca store sqlite switch` moves a workspace's metadata from files to SQLite,
  with every other ORCA stopped: a verified backup of the whole store first, then the import
  and a verify, and only then the store's format marker. From then on the workspace runs on
  SQLite, `orca store format` says so, and earlier ORCA versions refuse the store rather than
  read the files it left behind. Refused on Windows for now, and for the desktop app's own
  workspaces (#339).
