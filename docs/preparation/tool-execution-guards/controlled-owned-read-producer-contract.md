# Controlled owned-read producer contract — #702 / #703 / #706

Implementation base: `8a98b5496e38e5c03cee722f3390383d2544e84d`. This contract
fixes the producer interface for the separately owned positive observer. It is
not an acceptance result. The existing candidate and unqualified service fixture
remain unchanged. No production configuration, accepted-build map or transport
can construct the private test supervisor capability.

## Entrypoint and original supervisor inputs

The TypeScript producer is `packages/cli/src/controlled-owned-read-test.ts`, emitted
as `@orca/cli/dist/controlled-owned-read-test.js`. It exports one test runner,
`runControlledOwnedReadTest`, and is not exported by the package barrel or mounted
in the daemon. The installed test child imports that physical emitted file; it
must not use a source loader, source symlink or replacement module.

The supervisor supplies callable assertions for its retained original image,
root identities/bytes and real lifetime lock. These assertions are synchronous,
check actual OS state and are called again at capture, qualification, final
authorization and physical dispatch. JSON, a report digest, a phase ack, a child
boolean and a refusal observation cannot replace them. The private connected
qualifier is created only after the supervisor has independently replayed a
separate successful bootstrap. The supervisor retains the original bootstrap
evidence reference, exact installed inventory and profile; the connected runner
must use those same originals. This is designated test authority, not production
acceptance or a real user's approval.

Each run has a fresh private base, managed roots, lifetime, store, credentials,
lease and service. The bootstrap instance is permanently closed before connected
qualification. The input is at most 4096 UTF-8 bytes; the supervisor retains the
actual bytes and exact offset/length (positive lane: offset 2, length 4). Both
connected captures enforce this interval independently of rule matching. The
core saved rule does **not** pin offset/length.

## Exact phase framing

Use the observer's retained distinct command/ack pipe FDs and fresh 64-lowercase-hex
tokens. For each phase the producer performs one complete decoded read of exactly
`orca-phase:<name>:<token>\n`, and only after all work settles writes exactly
`orca-done:<name>:<token>\n`. Partial, duplicate, reordered or unexpected input
refuses; no retry is inferred safe from a missing ack. The command read completion
and ack write entry delimit the effect window. Do not use `raw=read` for control
bytes. All effects outside windows must also be replayed. A phase ack is neither
a lease ack nor evidence of success.

| Run / phase | Required real operations | Resource preads / live answers |
| --- | --- | --- |
| bootstrap / `bootstrap` | Fresh managed enrollment, disposable auth/lease, authenticated narrow baseline authorization, unchanged policy-per-ask service, actual strict evaluate → canonical authorize → dispatch, service close | exactly 1 / 0 |
| connected / `save` | New qualified service; actual live ask; protected facts before original capture; exact authenticated initial-revision baseline with **no matching allow rule**; genuine require-human; distinct persistence attestation; authenticated bridge review and explicit Save; one-time actual facade refresh | 0 / 0 |
| connected / `human-read` | New bridge review; separate explicit Allow once; actual original callback; successful final ownership ack; original completion → canonical human verdict/authorization/dispatch; duplicate attempts cannot add effects | exactly 1 / exactly 1 |
| connected / `rule-read` | New invocation ID, protected facts before fresh capture; separate closed automatic capture index, no live query/options/delivery; genuine saved rule evaluation → rule verdict/authorization/dispatch; service close | exactly 1 / 0 new |

For lost final ack, durable `human.answered` may exist and the callback may already
have returned; no human verdict, permit or read may follow. The normal original
executor awaits genuine settled delivery before any fresh evaluation. Tests also
hold the final ack promise to verify pending completion, then release or reject
it. This is separate from phase framing. Fresh automatic entries cannot bind or
complete human delivery.

## Finite private state grammar to implement in the observer

All paths below are beneath the supervisor's freshly retained run base `B`.
`W=B/workspace`, `S=W/.orca`, `C=B/control`, `R=B/releases`. Before launch, retain
physical identity and bytes of every original root/file, including inventory,
plan, `S/workspace-identity/id`, `C/never-typed` and the lifetime lock. Only the
following state families are needed. Templates are bounded name grammars, never
an unlimited exemption: replay must bind each generated UUID/PID/ref on its first
exclusive creation and reject any alias or second lineage. The implementation
will provide the actual finite observed sequence for the final head; this table
is the publication grammar, not permission to skip unexplained operations.

| Family | Paths, flags, modes and publication lineage |
| --- | --- |
| managed enrollment | `C/intent.json`, `C/enrolled.json`, and `W/orca.permissions.json`; existing managed enrollment performs exclusive private publication and retains original identity/control bytes. The sidecar writer uses `W/orca.permissions.json.<pid>.tmp`, exclusive `wx` 0600, then same-parent rename to the exact sidecar under its strict lock. No identity replacement is permitted. |
| disposable credentials | `B/credentials.json`; lock directory suffix `.lock`; temporary `credentials.json.<pid>.<8hex>.tmp`, private 0600 write/chmod then rename to that exact final file. Only test operator and distinct test persistence reviewer are issued; neither raw token is emitted as semantic evidence. |
| real lease | `S/leases/run%3Acontrolled.json`; temporary final + `.<pid>.<base36>.tmp`. Initial write → exclusive link to final → unlink temporary; renewal write → rename to same final. Normal lane never steals, breaks or force-releases another lease. Existing store uses ambient 0022 for these files inside the 0700 run root. |
| protected execution | `S/private-execution/.execution-key` (32 bytes, 0600), `controlled.inputs.json` and bounded `encodeURIComponent(ref).payload.json`; 0700 directory. Each immutable encrypted record uses exact final + `.<uuid>.tmp`, exclusive `wx` 0600 → write → fsync → close → exclusive hard link to final → directory fsync → unlink temporary. The observer must retain identical source/final inode lineage and decoded authenticated record identity. A link to/from the service resource is forbidden. |
| actual event journal | `S/runs/controlled.jsonl` and its exact `.lock` directory. Ordinary append uses the existing append handle/read/sequence/append/close protocol; no repair/truncate is expected in the normal lane. Public markers refer to actual encrypted payloads. |
| locks | Only canonical writer lock directories for the preceding exact files plus the run lease mutation fence. Existing `withFileLock` uses 0755 directories and `owner.<pid>.<uuid>.json` files 0644 under ambient 0022 inside private parents. Each ownership token is exclusively created, inspected and unlinked before its directory is removed; no stale-owner recovery or arbitrary recursive deletion is accepted. |
| service resource | One `TMPDIR/orca-owned-service-<six alnum>/fixture` per run. mkdir 0700; exclusive writer `O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC` mode0400; exact retained content write; writer close; readonly `O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC` reopen; physical inode/size/uid checks; unlink; positional reads only of the same detached inode; reader close and empty-directory removal. No unrelated open is accepted during its named interval. |

Producer-owned records are bounded to 64 KiB each, 128 distinct protected payloads,
256 journal entries and 16 MiB total mutable-state bytes per run. Image reads use
the exact original inventory sizes instead. The supervisor bounds total trace at
256 MiB and each run at 60 seconds. Read-only original image/root/lifetime checks
need explicit exact paths and descriptor lineage too. Unknown effects, batch
transfer/AIO, descriptor/path aliases, extra process creation, unsupported syscall
vocabulary, cross-phase intervals and uncertain cleanup retain refusal semantics.
There is no bare `.orca` or private-root exemption.

## Authenticated semantic evidence

The producer stores semantic payloads through the real `ExecutionStore`, never a
parallel store. Each reference resolves to authenticated encrypted bytes and is
rechecked by `execution.observe` plus its final synchronous unchanged assertion.
The independent observer must read those actual records and correlate the real
events, sidecar and trace; child `passed` or `qualified` flags are not evidence.

* Bootstrap/baseline authorization: version/kind, exact canonical binding,
  test operator credential identity and current authorization, lease, exact
  revision, pinned profile/image/evidence reference, expiry and planned interval.
  The connected initial baseline has no rule and applies only to the exact
  retained initial revision. Once Save changes revision it cannot be used again.
* Persistence review: separate kind `controlled-persistence-review-v1`, exact
  original immutable action and canonical scope/binding, revision, actor,
  distinct reviewer credential/authorization, lease and expiry. It is checked at
  prepare, Save, final publication and saved-proof lookup. It does not modify or
  assert success of an execution judge review. A refreshed action needs a new
  exact attestation; the old attestation remains immutable.
* Save: the protected owner's actual `agent.permission` encrypted payload,
  `decision=scoped-rule-save-accepted`, with its existing strict `entry` shape:
  command/rule/revision/approval ref, action, actor/credential, binding, target,
  lease, scopeEvidenceRef, reviewSourceRefs and acceptedAt. The actual typed
  sidecar record must match it; no Save event can substitute for a live answer.
* Answer: actual `human.requested` and `human.answered` with original target,
  actor and once option. Only the in-memory original registry proof after final
  lease acknowledgement can supply `acceptedAnswerRef`; durable history alone
  cannot recreate it. Diagnostic records may correlate that ack but cannot grant
  delivery authority.
* Authorizations: actual canonical verdict/receipt records keyed by original
  action binding. First has `authorizedBy.kind=human` and the exact answered
  reference; second has `authorizedBy.kind=rule` and exact saved rule/revision.
  Both retain different invocation IDs, real action/capture bytes, actual permit
  lineage and observed bounded OS result. No producer observation is accepted as
  independent effect proof.

Explicit test principals, reviewer/operator designation, cooperative same-UID
supervision and the supervisor's narrow profile authorization are assumptions.
Physical identity/currentness, authenticated persistence, genuine Save and live
delivery, canonical attribution and OS effect reconstruction are checks. Positive
integration remains pending until the connected producer and independent observer
actually agree on the exact tested head.
