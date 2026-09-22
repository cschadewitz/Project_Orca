Event logs, artifact indexes and claim records retain their existing schemas.
Lease records add backward-readable `guardedTtlMs`, `guardedHost` and `guardedId`
coordination metadata. Existing on-disk TTL and host fields contain sentinels that
prevent older automatic TTL/PID takeover; upgraded readers restore the actual values.
All legacy or unreadable leases require quiesced recovery, even after a legacy PID
has died. Mutexes use transient directories with unique owner tokens, preventing a
delayed stale remover from deleting a successor. Abandoned legacy lock files and
empty/unknown mutex directories also fail closed. Stop old writers and use upgraded
administration tools; see `docs/v0.5.2-ownership-compatibility.md` for recovery and
downgrade limits.
