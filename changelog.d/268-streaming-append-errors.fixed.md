- **engine:** a failed `agent.update` append no longer ends the process. The streamed
  output of a turn goes onto one serialised chain rather than a fire-and-forget promise per
  update, so a store that refuses a write — a torn lock file, a full disk, a store directory
  that went away — is caught, logged once against the step, and surfaced when the turn ends
  as a `STORE_WRITE` failure of that step, which the node's retry budget then applies to.
  Coalescing is unchanged: the buffer still flushes at 4000 characters and when the kind of
  update changes.
- **cli:** `orca` installs `unhandledRejection` and `uncaughtException` handlers at its
  entry point. Anything that escapes a command is logged with its ORCA code instead of
  arriving as Node's default crash, and `orca serve` keeps serving through it — one run's
  failed append used to lapse the lease of every other run the daemon was driving.
