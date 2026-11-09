- **agents:** An agent can no longer grant itself permissions. ORCA's own files — the config,
  `orca.permissions.json`, the store (but for the `work/` and `program/` deliverable areas) and
  `auth/` — are refused to every agent ahead of any permission rule, `default: allow`
  included, and by the `fs/read_text_file` and `fs/write_text_file` handlers; `auth/` and the
  store's key directories cannot be read either. Paths are resolved through symlinks and `..`.
  A wildcard `allow` in the sidecar is ignored with a warning (write one in `orca.config.yaml`
  instead), and an unreadable sidecar turns every `allow` decided after it into `ask` rather
  than letting a default allow through.
- **daemon:** `config.get` leaves a sidecar wildcard `allow` out of the effective policy, as
  evaluation does.
