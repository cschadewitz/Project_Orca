- **cli:** `orca validate` preserves absolute workflow filenames and globs instead
  of prefixing the working directory. Relative arguments still resolve from the
  working directory, and configured defaults from the config directory.
