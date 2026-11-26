- **store:** a lock left behind by a power loss no longer wedges the daemon. A lock taken before
  this machine's last boot is cleared even when its pid was reused or its owner file never
  reached the disk, so a managed server that lost power while a background tick held the retry
  journal's lock recovers on its own instead of failing every 5 s (#1197).
- **cli:** the daemon's continuation recovery logs once when it starts failing, with the error
  code and message, and once when it runs again, instead of "Continuation recovery requires
  explicit attention" every 5 seconds with no reason (#1197).
