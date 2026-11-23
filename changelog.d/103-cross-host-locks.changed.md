- **store:** Sharing one store between hosts or PID namespaces over a shared volume is
  documented as unsupported (`docs/storage/file-locks.md`). A lock held from another host
  is never broken, whatever its age: writers elsewhere wait and fail with
  `STORE_LOCK_TIMEOUT`, and a test holds that in place.
