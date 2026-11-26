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

A holder from **an earlier boot of this machine** is dead whatever its pid now names, so
after a power loss (#1197) a contender also takes the lock when the token names this host and
was written before this boot, even if its pid has been reused by another process or by the
restarted daemon itself. On Linux, where the token recorded a liveness domain, the kernel boot
ids decide; elsewhere the token's `at` must be older than the boot time. For the same reason an
empty lock directory, or a token whose bytes never reached the disk (zero bytes or torn JSON),
is cleared when it predates this boot by its modification time. Locks taken with
`recovery: "provable"` (the config file's lock) keep the stricter rule and are never cleared
this way.

Anything else fails closed. That covers a token recording a different hostname, whatever its pid
and however old it is; a token with no `host` (written before hosts were recorded); an
empty directory or a malformed token from this boot; and an older lock file. The contender keeps waiting
with backoff and, at its deadline (60 s unless the caller sets `timeoutMs`), fails with
`STORE_LOCK_TIMEOUT`. The holder's token is left exactly as it was. The age of a lock
never breaks it: `staleMs` is still accepted but has no effect.

This is only a statement about what this lock code does with a token it cannot judge:
it does not reclaim it. It is **not** a claim that an unsupported shared store is safe.
Shared-filesystem semantics (caching, rename and create atomicity, delayed visibility)
and duplicate hostnames are outside what the lock can detect, and either can still let
two writers in or damage data. Do not run a store this way.

`packages/store/test/file-lock-cross-host.test.ts` holds this behaviour in place: a
remote token with a pid that is dead here, one with a pid that happens to be alive
here, a token with no host, a lock held through the real protocol by a second
(simulated) host, and recovery only after manual removal.

## Recovering a lock by hand

A `STORE_LOCK_TIMEOUT` is **not** proof that a lock was abandoned: a live holder on
another host, in another container, or simply slow looks exactly the same. Remove a lock
by hand only when you can do all of the following; if any holder cannot be accounted for,
stop and leave the lock in place.

1. **Account for every writer.** Positively identify every ORCA process (daemon, CLI,
   app, scripts, test harnesses) on every machine and container that can reach the store,
   confirm each one has stopped, and prevent each from restarting (disable services,
   timers and autostart) until you finish.
2. **Check it is the right lock.** Confirm the directory named in the error
   (`details.path`) is inside the store you intend to recover, and that its owner token
   names a holder you have accounted for in step 1.
3. **Take a consistent backup** of the whole store while every writer is stopped, and
   keep it until the store has run cleanly again.
4. **Move to one local owner.** Put the store on one host's local disk with a single
   owning ORCA installation, so the shared topology cannot recur.
5. Only then remove that one lock directory (nothing else in the store) and start ORCA
   on the owning host.

## Not done yet

Supporting writers across hosts or PID namespaces would need a lock whose liveness does
not depend on the local process table, such as a holder heartbeat with an age-based
takeover, or a recorded host identity stronger than the hostname. That design stays
open on #103 and is not part of 0.8.0.
