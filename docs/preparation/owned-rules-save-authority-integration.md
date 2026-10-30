# Standing rules and post-approval authority

The optional Save eligibility projection describes retained prerequisites for
requesting fresh Save checks. It grants no authority and does not change the
execution-review result. A new client receiving an older response without this
field keeps its conservative passed-review gate. Older clients use strict result
schemas and may reject newer response fields, including this projection and the
earlier `standingReview` field. This is not bidirectional wire compatibility:
activation requires matching client/daemon contracts or reviewed capability
negotiation. Rejection fails closed; it does not grant execution or Save authority.
The UI and eligibility projection conservatively block an explicitly failed
execution review. This presentation veto does not change the backend's existing
independent persistence-review alternative or its final Save authority checks.

This draft integrates the inactive owned-read preparation APIs and their local
tests. It does not activate a production mount, add provider continuation, or
change the overall agent-turn timeout.

## Rule lifetime and live execution

New explicitly approved standing rules use schema version 2 with `expiresAt: null`
and disclose **Until revoked**. This supersedes the earlier finite-duration plan
for new standing rules. Existing finite rules keep their original schema and
expiry; this change neither migrates nor extends them.

A standing rule does not supply live execution authority. Every later invocation
still needs a fresh finite action, current ownership and lease, policy and
credential checks, unchanged physical scope, and a one-use execution permit.
Original grantor and reviewer revocation checks remain required.

New writes are not downgrade-compatible merely because old finite records remain
valid. Older strict readers do not understand rule version 2 or protected standing
approval versions 2/3 and may refuse the affected typed sidecar or grant material.
Do not rewrite standing rules into legacy finite approvals, drop protected
provenance, or infer restart recovery from the new schema. Preserve matching
protected approval and key material. Store compatibility and rollback need their
own review/rehearsal before activation or release; this draft changes no store
epoch or release policy.

## Human waiting and Save

A pending Save intent binds the historical capture, exact proposed command,
actor, scope and workspace identity. It grants no execution permission. The
displayed review handle has a separate finite freshness deadline; refreshing
disclosure does not refresh the original action.

An authenticated Save choice obtains fresh mutation authority, bounded to at
most 60 seconds and clipped to the actual remaining lease and credential
lifetimes. Protected approval version 3 binds that authority to the exact retained
intent and standing review. Publication must finish inside the fresh window.
Legacy approval versions retain their existing meaning.

Save performs no resource read and supplies no execution answer. A separately
acknowledged human approval can authorize a new read under its own fresh window.
Cancellation invalidates pending work; uncertain publication consumes its attempt
and does not trigger an automatic retry.

The separate initial-query candidate now reserves the original callback before
creating a review-only preview. That preview cannot authorize or dispatch. A
long-wait Allow once uses the exact private reservation, awaits the original final
acknowledgement and obtains fresh current authority for one new action. Ordinary
capture cannot redeem a reserved lineage, and old preview methods cannot execute
or reopen it. Legacy captures retain their original finite execution semantics.
See [initial approval intent](owned-rules-initial-approval-intent.md) for the
opt-in scope, cleanup requirements and evidence boundaries. This does not provide
durable approval after provider termination.

## Integration and evidence boundaries

The included disposable producers and focused tests exercise the until-revoked,
post-approval and pending-Save paths. Their test supervisor and reviewer are
explicit assumptions. They do not establish installed provider confinement.

The independent observer stack remains in the existing draft observer lineage,
including PR #785. This product branch does not copy its Python tools, historical
observation documents, physical images, traces, protected originals or private
review packets. Evidence from the frozen source at
`2d49969f26a34052a8da21bea7586e762dd7bee0` retains its original byte and source
scope; it is not an exact-image acceptance claim for a differently assembled
integration commit.

Pending intents here are retained within their live owner. Recovery after
process loss, credential continuity across restart and continuation of a timed-out
provider callback remain separate work. Loading a provider session does not prove
that an old permission callback can resume.

## Retained preparation run

On 29 October 2026 the separate frozen observer candidate above completed one
bootstrap and connected preparation pair on Linux x64, Node 24.21.0 and stock
strace 6.13, with `UV_THREADPOOL_SIZE=4`. Its connected capture and genuine test
owner/lease were bounded to 300 seconds, with a 2 GiB raw-trace ceiling. Individual
read actions retained their 55-second windows; fresh Save authority remained at
most 60 seconds and was clipped to current lease and credential lifetimes.
The separate outer worker allowed 900 seconds for capture, replay and cleanup;
the five-minute capture bound did not govern the whole replay operation.

| Lane      | Capture seconds | Trace bytes | SHA-256                                                            |
| --------- | --------------: | ----------: | ------------------------------------------------------------------ |
| Bootstrap |    20.496959480 | 106,305,818 | `e1aa73c1ef0ebc692e27155168a4e4dda463a03a3066747ff3758c29094892f5` |
| Connected |   195.635255591 | 775,348,997 | `65364b2cae3972684639c371903f4b524cff8f2a1d4be86c726b2df3411a2873` |

The original supervisor's kernel replay and composed semantic/effect inventory
returned without refusal. Save performed zero resource reads and zero execution
answers; human-read and rule-read each performed one resource read. Authenticated
retained records place Save acceptance 34,617 milliseconds after the original
action expired, inside a distinct fresh 60-second Save window, and correlate
later distinct actions with the same until-revoked grant. These correlations do
not reconstruct or independently measure live in-memory authority.

The outer launcher returned its expected preparation-only exit code 2 after
390.956646050 seconds: `pair-returned-unqualified`, `authority: none`, no accepting
token and no production eligibility. A separate retained-byte audit verified 63
files totaling 1,424,119,389 bytes, the absence of all four recorded process IDs
and availability of both lifetime locks. Its record SHA-256 is
`b0c1e59cf54fc7605ab3a6f6daf97cc72177c85e3004945dc957dbb2c2712825`.
Private trace/original bytes, keys and protected payloads are not included here.

This successful preparation run does not qualify installed providers, arbitrary
filesystem/shell effects, restart recovery, production activation or the complete
acceptance scope of #706. It used zero descriptor-reuse certificates, so it does
not supply live coverage for that separate observer candidate. Earlier refused
attempts remain refused and retained. The extracted product branch requires its
own source, unit, integration and CI checks; the prior physical image is not an
image of this branch.

## Existing work and remaining decisions

This builds on merged scoped-policy and owner integration (#717, #733, #736 and
#738), coordinated by #699/#702/#703/#706. The observer drafts #762, #765, #766,
#768, #769, #781 and #785 retain their separate review history and preparation
scope. No existing issue is closed by this extraction.

Durable tool approval must distinguish a protected, nonexecuting grant intent
from an expired provider callback. The current durable continuation boundary is
for selected root workflow decisions and explicitly excludes permission callbacks.
Keeping a request visible after timeout requires an explicit durable owner and
step lifecycle, cancellation tombstones and current-authority checks. Automatic
new prompting versus an explicit Continue action, one-use future-invocation
consumption, and pending-intent retention/privacy policy need deliberate contracts;
none is implemented by silently widening the existing continuation validator.
