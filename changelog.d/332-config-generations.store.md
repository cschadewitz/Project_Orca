The store compatibility epoch advances to `config-generations-v3`. New protected
configuration-generation records and generation-bound run/admission metadata require a
runtime that understands those bindings. Existing protected-execution-v2 encryption,
keys and records remain intact; this is not a plaintext migration or key rotation.

The managed Debian updater refuses automatic activation/rollback when release metadata
has different store epochs. Direct daemon/CLI startup does not enforce that epoch;
manual rollback to an older binary is not guaranteed to refuse the store and is not a
supported migration. Retain a complete pre-upgrade store backup, including protected
material and keys, with its matching binary. Custom executable plugin registrations
can prevent generation restoration after an engine-process restart; see #394–396.

Generation snapshots now embed their workflow definitions without pinning unlaunched
workflows. Older binaries that ignore those definitions cannot restore a generation when
any catalog workflow lacks a pin, even if both builds report `config-generations-v3`.
Snapshot compatibility is one-way; an equal epoch does not make binary-only rollback safe.
