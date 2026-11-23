- **store:** Sharing one store between hosts or PID namespaces over a shared volume is
  documented as unsupported (`docs/storage/file-locks.md`). A lock whose owner token
  records a different hostname is never reclaimed, whatever its age: contenders wait and
  fail with `STORE_LOCK_TIMEOUT`, and a test holds that in place. This does not detect
  two hosts or containers that share a hostname, and does not make a shared store safe.
