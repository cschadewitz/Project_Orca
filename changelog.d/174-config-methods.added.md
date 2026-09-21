- **protocol:** `config.get` and `config.set`, the `config.changed` notification and the
  `CONFIG_STALE` error code; protocol 1.7. `config.get` is a read under `runs.read` and
  `config.set` a write under `runs.control`, so a `--read-only` daemon answers the first and
  does not have the second.
- **daemon:** `orca serve` serves the workspace's configuration. `config.get` returns the
  raw text, the parsed document and a description of the config schema — field paths, types,
  enums, defaults — walked off `OrcaConfigSchema` rather than written out by hand.
  `config.set` takes a whole document or a list of field patches; a patch edits the YAML in
  place, so comments and formatting survive and no schema default is materialised into the
  file. A schema failure comes back as `CONFIG_INVALID` with the errors keyed by dotted path
  (`hosts[1].type`), and `validateOnly` reports them without writing. A write against a
  revision the file no longer has is refused with `CONFIG_STALE` rather than overwriting
  what landed in between.
- **daemon:** `config.set` reloads nothing — the daemon goes on serving the configuration it
  booted with until the next `orca serve`. It takes no run lease and appends no event, so
  editing the config while a run is in flight disturbs neither.
- **app:** `window.orca.config.get` / `.set` on the preload bridge and `DaemonClient`.
  Plumbing for the Configuration and Agents surfaces (#175, #176); no UI yet.
