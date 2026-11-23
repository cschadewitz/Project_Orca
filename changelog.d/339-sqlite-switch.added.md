- **store:** ORCA writers (the daemon and CLI commands, `orca store sqlite import` and
  `restore`) now register while they have a store open, so a later change of who owns a store's
  metadata can be refused while any of them is running, idle or not. A store recorded as running
  on SQLite opens only the database it was bound to, and refuses a missing or replaced one
  instead of starting empty. `orca store format` says whether a store's metadata is in files or
  SQLite. `orca store sqlite switch` exists but is refused for now, changing nothing: ORCA 0.7.0
  and earlier never read the store's format marker and do not register, so nothing can make sure
  none of them is still running against the store (#339).
