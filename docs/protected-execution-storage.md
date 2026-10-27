# Protected execution inputs and public history

New sensitive launch inputs are split at admission. The private execution store
keeps the exact resolved vars, sensitivity names inherited by children, and known
sensitive literals. The public `run.created` event carries a redacted view and an
`executionInputsStored` marker. Any nested sensitive declaration hides its entire
top-level input, including siblings. Child admission retains sensitivity even
when the child has no input schema.

The event-store facade scrubs copied literals from free-form payloads before the
public append or subscriber notification. For every event of a protected run it
first persists the authoritative original privately and puts only an opaque
`executionPayloadRef` in the public event. This is an internal record identity,
not a retrieval capability: no RPC serves it. Opaque payload keys as well as
values are scrubbed. Identifiers, enum tags and counters retain their schema
meaning; coincidental short/numeric/boolean matches must not corrupt the graph.
An unrepresentable public projection fails before any public append.

ORCA's own renderings can move a value past literal scrubbing: a template formats an
object as YAML, a function transforms it, the 400-character prompt preview cuts it.
For a run with sensitive names the public `promptPreview` is therefore `[REDACTED]`
(its `promptHash` stays), and a sensitive `itemWorkflow` value read from vars is
withheld from launch provenance. A port that shows a human question to a person, such
as the terminal prompt, shows the published `human.requested` text.

Child-only sensitive defaults propagate upward before exact child state returns.
The parent is promoted using its original admission vars plus append-only encrypted
sensitivity overlays. Already-created logger scopes consult the updated sensitivity
at log time. Each authenticated private payload binds the overlays required at its
append. Public reads validate the latest such reference, so missing protection
records cannot silently weaken redaction of related artifact content.

The interpreter replays private payloads and initial vars, then applies later
`vars.set` events exactly. A separate state reduced only from public events serves
live reads, completed results and cached states. Human-input acceptance hydrates
the authoritative gate under its run lease. A missing or corrupt private input,
payload, snapshot or key fails closed; redacted placeholders are never execution
values. The existing immutable workflow-version selection remains authoritative.

## File format, keys and backup

`private-execution/` holds encrypted input/payload records;
`private-workflows/` holds encrypted new workflow snapshots, including sensitive
defaults. Each directory owns a distinct `.execution-key`. Records use AES-256-GCM,
a random 96-bit nonce and a 128-bit authentication tag. Associated data binds the
ciphertext to its directory kind and complete record filename, so swapping two
records fails authentication while a complete backup can move to a new root.

On POSIX systems these directories are created with mode 0700 and files/keys with
0600. Existing unsafe permissions or symlinks are refused, never silently changed.
Windows deployments must retain owner-only inherited ACLs on the private store;
POSIX mode checks do not constitute a Windows ACL audit.

Key and ciphertext bytes are flushed before immutable hard-link publication.
Concurrent first writers select one key without replacing it. The directory entry
is flushed before a public reference is written. A crash before the public append
can leave an unreachable encrypted private record; it cannot leave a published
reference to a write that was not completed. There is no automated deletion or
key rotation.

Back up both private directories, including their hidden key files, together with
public events. Restore them as a unit and preserve access controls. A records-only
backup cannot resume execution. Missing, truncated, or replaced keys are never
regenerated over existing ciphertext. Decryption/authentication/parse failures use
generic diagnostics without including source bytes. In-memory stores retain
plaintext only inside the runtime process and clone records at their boundaries.

Existing `workflows/` snapshots retain the historic read/list fallback. New
snapshots go only to the protected location; this change does not rewrite,
re-encrypt, delete, rotate keys for, or relax permissions on existing user data.
Tests create and remove isolated synthetic fixture keys only.

## Threat model and limits

The boundary protects against disclosure through public raw event logs, run views,
notifications, replay and execution logger fields, and against accidental copying
of encrypted record files without their keys. It does not protect against a
compromised daemon account/root that can read both key and ciphertext, memory
inspection, a malicious executor, or credentials a workflow deliberately sends to
its authorized execution tools.

Literal scrubbing is defense in depth, not arbitrary taint tracking. Encoded,
hashed, transformed or fragmented values are not recognized. It covers known
admitted values/defaults and inherited sensitivity, not newly invented secret
values assigned by arbitrary executor code. Runtime metadata remains metadata;
a secret that happens to equal an identifier does not erase that identifier.
Consumers of authoritative artifacts or other stores must use their own protected
public projection or withhold the content. The event projection alone is not an
artifact-body access boundary.

The storage epoch is integrated at the daemon/client compatibility fence. Older
binaries must not open protected stores and treat safe display values as executable
launch inputs.
