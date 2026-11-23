# File locks and shared volumes (#103)

The file store serializes writers with mutex directories (`withFileLock`,
`packages/store/src/file-lock.ts`). This page says which deployments those locks
support and what happens outside them.

## Supported

- **One host, one PID namespace.** Every process that writes a store (the daemon, a CLI
  command, a test harness) runs on the same machine and can see the others' process ids.
- The store directory is on a **local filesystem** of that host.

## Not supported

- **Writers on more than one host sharing a store** over NFS, SMB, a FUSE mount or any
  other shared or synced volume. Two daemons, or a daemon and a CLI command, on
  different machines must not point at the same store directory.
- **Writers in different PID namespaces** on one host (for example a container and the
  host, or two containers) sharing a store through a bind mount or volume. A container
  often has a different hostname, which is refused as below. If it has the *same*
  hostname, the lock cannot tell it apart from a local process, so this topology is not
  only unsupported but unsafe: do not run it.

Machines that work together do so through the daemon's protocol, not by sharing a store
directory: remote daemons own their own stores ([Running across machines](../MULTI-MACHINE.md)).
The SQLite backend has its own, stricter rule for the same reason: never put
`metadata.sqlite` on a network share ([SQLite metadata](sqlite-metadata.md#deployment-and-topology)).

## What a lock does with a holder it cannot judge

A lock directory holds one owner token, `owner.<pid>.<uuid>.json`, recording the
holder's `pid`, the time it took the lock (`at`) and its `host`. A contender removes
the token and takes the lock only when **all** of these are true:

- the token is well formed and is the only entry in the directory;
- its `host` is this machine's hostname;
- its `pid` is not a live process here.

Anything else fails closed. That covers a token from another host, whatever its pid
and however old it is; a token with no `host` (written before hosts were recorded); an
empty directory; a malformed token; and an older lock file. The contender keeps waiting
with backoff and, at its deadline (60 s unless the caller sets `timeoutMs`), fails with
`STORE_LOCK_TIMEOUT`. The holder's token is left exactly as it was. The age of a lock
never breaks it: `staleMs` is still accepted but has no effect.

So the unsupported cross-host topology does not corrupt a store through the lock: it
stalls. While the remote holder is alive and releases normally, writers on the other
host simply wait their turn. If the remote holder dies holding the lock, every writer
elsewhere times out until someone intervenes.

`packages/store/test/file-lock-cross-host.test.ts` holds this behaviour in place: a
remote token with a pid that is dead here, one with a pid that happens to be alive
here, a token with no host, a lock held through the real protocol by a second
(simulated) host, and recovery only after manual removal.

## Recovering an abandoned lock by hand

When a lock is held by a holder that no longer exists on another host (or one that
cannot be judged for any reason above):

1. Stop every ORCA process that writes the store, on every machine that can reach it.
2. Remove only the abandoned lock directory named in the `STORE_LOCK_TIMEOUT` error
   (`details.path`). Do not remove other files in the store.
3. Start ORCA again. Move the store to one host's local disk before you do, so the
   situation cannot recur.

## Not done yet

Supporting writers across hosts or PID namespaces would need a lock whose liveness does
not depend on the local process table, such as a holder heartbeat with an age-based
takeover, or a recorded host identity stronger than the hostname. That design stays
open on #103 and is not part of 0.8.0.
