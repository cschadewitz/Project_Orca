Establish `operator-journals-v4` and protocol 2.0 for operator, admission, continuation and
revision integration. Closed protocol 1.10 capability/event schemas cannot consume the new
wire contract, including `revision.recorded`; upgrade clients and daemons together.
Optional feature methods remain provider- and authority-gated, not globally required.

The managed updater refuses activation/recovery across store epochs. Direct CLI/daemon
startup does not enforce the release marker, and direct in-place downgrade is unsupported.
Before upgrade, stop all writers and retain a complete, consistent backup of both stores,
protected payloads, all journals and associated state with its matching old binary and
toolchain. Rollback requires restoring that complete pre-upgrade backup; switching binaries
cannot undo new writes. Old full-schema readers reject valid unknown events, while filtered
reads may bypass them, so a successful read does not prove downgrade safety. See
`docs/UPDATING.md` for the migration and recovery boundary.
