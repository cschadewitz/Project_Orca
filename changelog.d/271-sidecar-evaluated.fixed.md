- **agents:** "Allow always" now takes effect. The `orca.permissions.json` sidecar (ADR
  0009) was written but never read at session time, so a standing grant a person recorded
  was asked about again on the very next tool call. `session/request_permission` now
  evaluates the agent's configured rules, the sidecar and the defaults together, re-reading
  the file per ask, so a grant recorded mid-run applies to that run's next tool call.
