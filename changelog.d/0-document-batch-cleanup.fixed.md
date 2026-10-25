- **store:** Discard failed document mutation batches when directory setup or lock
  acquisition fails, so reads and later writes do not revive rejected changes.
  Preserve mutations queued for subsequent writes.
