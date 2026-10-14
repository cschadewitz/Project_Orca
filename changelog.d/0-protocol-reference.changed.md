- **protocol:** The protocol reference now documents the whole 2.0 surface: an inventory of
  all 83 daemon methods with the grant each needs and what installs it, the 32 capabilities,
  `maintenance.runtime` with drain and defer, `ORCA_MAINTENANCE_TOKEN` and
  `ORCA_ADMISSION_FILE`, `runs.admit` and `admissions.*`, continuation, revision, the six
  operator reads (a stale cursor is a `restartRequired` page) and ten operator mutations, and
  the eight `templates.*` and eight `workflowDrafts.*` methods, which arrived within 2.0
  without a minor bump. It corrects what it said about `PROTOCOL_VERSION` (a client-side
  code; a version mismatch answers `NOT_SUPPORTED`), `config.set`'s grants (`config.write`
  and `config.read`), `runs.start` under default `orca serve` (a durable admission that
  refuses with `RUN_STATE` when it needs reconciliation), and the 1 MB `/rpc` body limit.
