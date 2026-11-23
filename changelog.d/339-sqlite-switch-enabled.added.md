- **store:** `orca store sqlite switch` now moves a workspace's metadata from files to SQLite
  on Linux and macOS (still refused on Windows, #947, and for the desktop app's own
  workspaces). ORCA 0.7.0 and earlier, which never read a store's format marker, are kept out:
  the switch puts markers at the paths they open first, so every one of their commands is
  refused before it writes anything. This is checked against the released v0.7.0 and v0.6.0
  builds in CI. A switch that is interrupted is undone, or finished, by the next start, and
  `orca store sqlite restore` refuses a backup of another workspace's database (#339).
