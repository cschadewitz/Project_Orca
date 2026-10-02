- **engine/daemon:** Integrate Request admission, configuration generations and live
  permission callbacks under protocol 1.10. CLI/ACP submissions use explicit current
  authority. Explicit same-principal resume can renew revoked execution attachment without
  reviving old tool decisions.
- **app:** Integrate authenticated daemon switching, persistent workspace/boot identity
  and connection epochs, plus connected live-permission invalidation. Correct connection
  error reporting, epoch synchronization and bundled endpoint handling.
