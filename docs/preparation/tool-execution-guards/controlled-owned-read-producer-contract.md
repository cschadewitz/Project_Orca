# Controlled owned-read producer contract — #702 / #703 / #706

Implementation base: `8a98b5496e38e5c03cee722f3390383d2544e84d`. This contract
fixes the producer interface for the separately owned positive observer. It is
not an acceptance result. The existing candidate and unqualified service fixture
remain unchanged. No production configuration, accepted-build map or transport
can construct the private test supervisor capability.

## Entrypoint and original supervisor inputs

The TypeScript producer is `packages/cli/test/controlled-owned-read/producer.ts`.
Build a new private image with `node tools/owned-read-proof/build-controlled.mjs
/absolute/new/image`. The builder refuses an existing target. The exact emitted
entrypoint is `controlled-child.mjs`; it imports `./controlled-producer.mjs`.
`controlled-build.json` pins the emitted hashes, source-input hashes and profile.
The test bundle exports `runControlledOwnedReadTest` and the bounded
`assertControlledLifetimeFdinfo` query helper; neither is in a production package
barrel or daemon mount. The image contains these three physical files, with no source loader, source alias or symlink. Bundling preserves
one shared instance of the actual stores, fence, registry and internal modules.
Ordinary tsc output was rejected for this lane because existing internal relative
source imports do not resolve in a package-only installed tree.

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
| managed enrollment | `C/intent.json`, `C/enrolled.json`, and `W/orca.permissions.json`; actual enrollment unlinks the exact `C/never-typed` witness, fsyncs `C`, exclusively opens `intent.json` with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC` 0600, writes/fsyncs/closes and fsyncs `C`; initializes the sidecar; then publishes `enrolled.json` with that same exclusive sequence. Original identity bytes remain fixed. The sidecar writer uses `W/orca.permissions.json.<pid>.tmp`, exclusive `wx` 0600, then same-parent rename to the exact sidecar under its strict lock. No identity replacement is permitted. |
| disposable credentials | `B/credentials.json`; lock directory suffix `.lock`; temporary `credentials.json.<pid>.<8hex>.tmp`, private 0600 write/chmod then rename to that exact final file. Only test operator and distinct test persistence reviewer are issued; neither raw token is emitted as semantic evidence. |
| real lease | `S/leases/run%3Acontrolled.json`; temporary final + `.<pid>.<base36>.tmp`. Temporary writes use `O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC` 0644 under 0022, and replay requires a fresh previously absent generated path. Initial write → close → exclusive link to final → unlink temporary; renewal write → close → rename to same final. Normal lane never steals, breaks or force-releases another lease. Existing store uses ambient 0022 for these files inside the 0700 run root. |
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


## Installed child arguments and retained plan

Invoke `node <image>/controlled-child.mjs B <bootstrap|connected> <lifetimeFd>
<commandFd> <ackFd>` with actual distinct inherited descriptors greater than 2.
The parent retains their kernel identities and reserves all fresh tokens before
launch. It creates `B/controlled-plan.json` with the following association data:

* `version: 1`, `lane`, `inputHex`, `offset`, `length`, ordered `phases: [{name,token}]`.
* `lifetime: {path,identity}`, `commandIdentity`, `ackIdentity`, and `roots: {path:identity}`.
  Identities are exact `[dev,ino,mode,uid,gid]`; command/ack must be actual FIFOs.
* `originalFiles: {path:{identity,sha256}}` for immutable original workspace identity
  bytes and, on connected runs, the supervisor-retained bootstrap proof file.
  `enrollmentWitness: {path,identity,sha256}` separately retains `C/never-typed`:
  the child checks it before work; actual managed enrollment consumes this witness
  before exclusive intent publication. Replay must match that exact unlink and
  confirmation lineage, rather than require the consumed witness to remain.
* `inventory: {path:{identity,sha256,stamp}}` for the same three original physical
  image files in both runs. `stamp` is `[dev,ino,mode,uid,gid,nlink,size,mtimeNs,ctimeNs]`
  encoded as decimal strings. Initial bytes are verified, and every synchronous
  currentness assertion rechecks physical stamps including ctime. Full independent
  replay must also verify the original hashes. This is cooperative same-UID change
  detection, not hostile same-UID protection.
* Connected only: `bootstrap: {evidenceRef,proofPath,proofSha256,installedInventoryDigest}`.
  The inventory digest is SHA-256 of JS `JSON.stringify(inventory)` preserving its
  supplied order. The proof must be an original retained file. These values bind
  associations; **authority comes only from the private parent command channel**
  after independent bootstrap verification. A candidate report/hash or arbitrary
  JSON cannot make the parent send the connected Save command.

The parent must not release a connected command following unsuccessful, incomplete
or unknown bootstrap verification. No accepting supervisor launcher is included in
this producer patch: the independent observer owner supplies that lane. The three
image files may be shared across two separate disposable run bases/lifetimes;
matching source text in a different physical tree is not the same retained image.


## Current measured subset and open observer work

[The bootstrap mutation/open measurement](controlled-owned-read-bootstrap-io-measurement.json)
contains 80 actual mutation syscall entries and 55 private-open path/flag
combinations from a successful physical bundled bootstrap run. It is explicitly
unaccepted entry sampling: unfinished/resumed calls are not paired in that file,
physical lineage and results have not received full independent replay, generated
names are observations rather than future authorizations, and the final image
must be rerun. This supplies actual store activity instead of a fabricated fixed
sequence. The raw bootstrap trace was 95,814,704 bytes and completed in about 24
seconds under strace. The completed canonical receipt and exact phase ack are
producer correlations; independent acceptance is still absent.

The connected TypeScript lane now performs actual Save, separately delivered
Allow once, and a fresh rule read in local tests with real temporary stores,
credentials, leases and a supervisor-owned flock. Test observation intercepts the
actual native positional call and checks returned bytes, but does not establish
external syscall confinement. Tests retain unavailable execution-review provenance
and separate authenticated persistence review, and cover deferred/lost final ack,
duplicate completion/dispatch, missing/revoked/tampered review, revoked actor/rule,
stale revision, wrong interval, root replacement and released physical lifetime.

Outstanding observer work is concrete: construct the two run plans using the
three-file image; independently replay bootstrap effects/records before sending
any connected token; add finite replay rules for the measured publication and
lock families (including read/close/fsync and paired completion), then reconstruct
all connected phases and semantic records. The connected external trace size and
runtime have **not** been measured or accepted. The current 256 MiB/60 second
contract bounds may need a smaller, fully checked observation encoding; exceeding
them refuses rather than silently widening or claiming acceptance. No runtime
acceptance, caller-supplied positive flag or generic private-root exemption is
being proposed to resolve that work.


The producer now snapshots the supervisor's callable capabilities and original
content/interval before its first await. Its final synchronous owner assertion
also hashes the actual current sidecar revision, checks the original real lease
file identity/stamp/bytes and expiry, and rechecks authenticated baseline and
persistence-record seals. Save refresh updates only the policy revision through
the actual facade. Fresh automatic capture omits a live target entirely; it cannot
complete human delivery. These extra real reads must be included in final replay;
the older measurement is not an exact-final-head I/O specification.

Fixed test designations retained by the parent before launch are run `controlled`,
workflow `controlled-test`, principals `controlled-test-operator` and
`controlled-test-reviewer`, instance `controlled-test-boot`, session
`controlled-session`, step `controlled-step`, attempt `controlled-attempt`, agent
`controlled-agent`, host `controlled-local-linux`, runner `controlled-runner`, and
captured generation `controlled-original-ceiling`. Original human turn/invocation
are `controlled-human-turn` / `controlled-human-invocation`; the fresh automatic
turn/invocation are `controlled-rule-turn` / `controlled-rule-invocation`.
Credential IDs, action IDs, approval refs and payload refs are actual fresh values
from the real stores and are correlated to these predesignated roles. The original
owner expiry is real wall time plus 55 seconds, below the fence's unchanged
60-second ceiling. No expiry or default coverage constant was widened.


## Source-owned lifetime fdinfo query

The child retains its existing lifetime-descriptor/path identity assertions and
kernel `FLOCK ADVISORY WRITE` content assertion. Only this source-owned query now
uses an explicit descriptor, through the helper in the existing producer bundle:

1. Open exactly `/proc/self/fdinfo/<retained lifetimeFd>` with
   `O_RDONLY|O_NOFOLLOW` (Node adds `O_CLOEXEC`).
2. `fstatSync(queryFd, {bigint:true})` before any read; require a regular file and
   positive inode. Its physical identity is the **query's** identity, distinct
   from the retained lifetime file's identity. On Linux/Node 24 this was observed
   as `statx(queryFd, "", AT_STATX_SYNC_AS_STAT|AT_EMPTY_PATH, STATX_ALL, ...)`.
3. Read sequentially on that same query descriptor, with `position=null`. Each
   request is the unused remainder of a 4097-byte buffer; accept at most 4096
   content bytes and require EOF before checking the unchanged flock expression.
   The extra byte detects oversize, including a valid flock prefix followed by
   additional content. Proc fdinfo may report size zero despite nonempty content.
4. Close only the query descriptor in `finally`, including stat/read/content
   failures. An open failure has no query to close; a close failure refuses.

The remaining root/image/control-FIFO assertions are unchanged. Existing trace/runtime budgets, owner expiry, default coverage, production maps,
credentials and OS settings are unchanged.
A new reviewed source/image pin and fresh runs are required; older traces remain
historical. This adds no generic kernel-query permission. The independent observer
still owns process/mount provenance and classification of Node/libuv/native
cgroup probes, as well as complete replay and bootstrap/connected acceptance.
