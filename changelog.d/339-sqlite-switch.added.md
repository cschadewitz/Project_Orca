- **store:** `orca store sqlite switch` moves a workspace's metadata from files to SQLite,
  with every other ORCA stopped, which it checks: ORCA writers now register while they have a
  store open, and the switch is refused while one is, idle or not (and, for a store an older
  ORCA has opened, until run with `--older-orca-stopped`). It takes a verified backup of the
  whole store first, then the import and a verify, and only then the store's format marker.
  A store on SQLite opens only the database it was switched to, and refuses a missing or
  replaced one instead of starting empty. From then on the workspace runs on
  SQLite, `orca store format` says so, and earlier ORCA versions refuse the store rather than
  read the files it left behind. Refused on Windows for now, and for the desktop app's own
  workspaces (#339).
