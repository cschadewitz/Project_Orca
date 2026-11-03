# Source byte safety and proposed private delivery profile

Baseline: `e4e909f85cad6342b6aa2c6f88025089148c4675`, draft PR #809.
This increment advances G4 finite original custody accounting and G7 byte delivery.
It restricts two real source outputs, without instantiating an observation issuer,
host custodian, transport or complete-source acceptance. All observer entry
refusals, pins, artifact grammars and existing deadlines remain in place.

## Source restrictions

The clock helper previously had a five-second process deadline but no output-byte
ceiling. No retained helper trace or measured installed-probe size was found in
the inspected repository/evidence. The main trace size is not evidence of the
helper's size. The selected engineering restriction is a **distinct 1 MiB per
clock-probe trace**, with an equal hard/soft file-size resource limit around the
fixed `/usr/bin/true` tracer command and a separately bounded native read. This
value is provisional compatibility headroom, not a measured compatibility claim
or a host storage grant. Overflow refuses; it does not expand or retry. A future
adjustment requires source review, independent boundary tests, renewed accounting
and separately authorized compatibility evidence; no environment override exists.

The five-second helper call and original settlement/cleanup deadlines remain
unchanged. A file-size resource limit does **not** bound subprocess pipe capture.
Tracer help/version still use deadline-only `capture_output`, and `run_traced`
captures helper stdout/stderr without a byte cap. Other Git/loader helper capture
has the same separate gap. Their selected hashes/metadata are retained, not full
standalone raw output. No invented stdout/stderr allowance or new artifact closes
that gap. Probe/tracer execution was not used to obtain measurements or tests.

Optional diagnostics derive their ceiling from existing construction, rather than
borrowing report or trace space. Let R=8192 bytes and S=62 samples. Three process
roles each have four bounded reads (before-stat, schedstat, io, after-stat); four
resource files add four more, giving 16 read groups per sample. ASCII escaping
costs at most six bytes per source byte. Each read group's aggregate values are
checked against G=6R+2=49154, separately from dictionary punctuation and fixed keys.
Counting each field as a fresh R-byte source would misdescribe this contract.

Parsed numbers and native scalar fields first receive a cheap 4R-bit check, then
a conservative signed decimal width N=2+floor(4R*30103/100000)=9866. Strict builtin
types, fixed field/role/resource names, source-length checks, pin shapes, fixed
error codes and at most two errors are checked before JSON conversion. The
detached validated snapshot excludes custom JSON hooks and caller mutation during
serialization. Python's existing integer conversion guard remains enabled and may
refuse sooner. The collector's own stat acquisition is also bounded.

The schema frames yield process P=270+4G=196886 and sample
Q=238+5N+3P+4G=836842. Pins contribute at most 237062, errors 45, configuration 450
and outer frame 81 bytes. The enforced canonical artifact ceiling is therefore:

```
D = 81 + 450 + (2 + 62*836842 + 61) + 45 + 237062
  = 52,121,905 bytes
```

Grouped preflight occurs before expensive serialization; a final length check and
the private writer enforce the same ceiling before a file is opened. This is a
serialized-file bound, not a small retained-memory claim, a filesystem I/O deadline
or a quota reservation. The existing one-attempt retention/cleanup path preserves
the first private failure and consuming uncertain resources once. Diagnostic
failure does not become observation acceptance.

## Recommended finite bundle and disposition policy

The [actual source inventory](complete-originals-receiver.md) remains authoritative
for filenames and physical distinctions. The proposed profile is exactly **one
original attempt, at most one bootstrap lane and one connected lane**, with optional
diagnostics enabled for both only if explicitly reserved. Failure dispositions
must record the reached stage; missing, consumed and not-started are distinct.
The future custodian must bind this inventory to the original acquisition. A
candidate-created inventory is insufficient.

| Content | Recommended disposition and accounting |
| --- | --- |
| Exact three image files | Keep native originals and hashes; count up to three designation snapshot maxima, 48 MiB total. Builder output is still checked after construction, not preventively disk-quota bounded. |
| Each lane's report, originals and main trace | Keep complete raw bytes: 1 + 1025 + 256 = 1282 MiB per lane. Original metadata remains a separate 1 MiB allowance inside that originals ceiling; no second journal is added. |
| Clock trace and optional diagnostics | Keep each reached helper's raw trace, at most 1 MiB; count D for each enabled lane. Preserve the original failure if either cannot be retained. |
| Plan, identity and surviving mutable state | Keep independently selected final original files, not a glob. Conservatively count plan 65536 plus identity 37 and another 16 MiB of final mutable bytes per lane, even where embedded copies overlap. Existing mutable replay acceptance is post-hoc; it is not preventive filesystem confinement. |
| Compact association and public checkpoint | Count existing 4096-byte association and derived 933-byte checkpoint. Association exists only after genuine original bootstrap closure. Neither substitutes for originals nor creates a receipt capability. |
| Consumed witness, unlinked staging/resource files and pipe/handle state | Preserve their original disposition and retained raw trace/original bytes. Never recreate missing physical files to make an inventory look complete. Uploaded bytes cannot carry original handles, permits or in-memory receipt identity. |
| Helper stdout/stderr and loaded-code provenance gaps | Label precisely as selected metadata or not retained. Producer report tail is not complete stderr. This profile cannot assert full acquisition of outputs the source does not retain or bound. |

For that proposed persisted-byte profile, using MiB=1048576:

```
B = 2*(1282 MiB + 1 MiB + D + 16 MiB + 65536 + 37)
    + 48 MiB + 4096 + 933
  = 2,878,912,081 bytes
```

B is a conservative profile envelope, not a proven preventive complete-run disk
bound: builder outputs, mutable writes before rejection, helper pipe capture,
artifact-count/disposition completeness and original physical/loaded-code closure
still need admission work. The receiver continues to refuse complete-source
certification unconditionally. This increment removes the two specific missing
source caps; it does not erase the other obligations.

For eventual owner review, recommend a **12 GiB private host quota for this one
attempt only**, outside guest snapshots, with no automatic second attempt/export
round. Budget B retained originals + B acquisition staging + B export chunks,
plus one 16 MiB chunk staging slot and a proposed 16 MiB total private catalog/index
allocation. The latter is explicit management capacity, not a new source journal;
the existing receiver index remains at most 4 MiB. This totals 8,670,290,675 bytes
before filesystem overhead F, leaving 4,214,611,213 bytes under 12 GiB. The actual
filesystem must qualify F, hard allocation/admission and behavior on exhaustion;
if it cannot, admission refuses. No quota, directory, principal, staging or export
allocation has been applied. Hard links to one inode do not duplicate its data,
but concurrent source/staging/export copies do. The conservative equation counts
all three copies even if a future reviewed stream transaction can reduce them.

Keep sole originals and uncertain transfers until the trusted operator resolves
their state. Lost acknowledgments require read-only reconciliation against durable
native state and hashes; they never authorize blind resend, overwrite or deletion.
The current one-report transaction supplies local mechanics only. A host disk
failure still loses this custody copy; it is not an independent backup.

## Privacy and a concrete manual delivery pilot

Recommend a private raw-evidence profile restricted to deliberately disposable
fixture identities and fixture-only credentials/keys, after explicit review of
every artifact family. Do not export production credentials, unrelated host files
or unreviewed archives. Complete protected payload replay may need disposable
decryption keys that a safe summary omits. Removing/redacting them changes bytes
and hashes; such a projection must be labeled separately and cannot count as
complete original evidence. Private paths and raw trace strings also need review.
The operator must decide the permitted assistant disclosure scope and retention
before any real raw export. No credentials are generated or revoked by this work.

First qualify a nonsecret manual pilot using one 16777217-byte artifact: exactly
16777216 ASCII `P` bytes followed by one ASCII `Q` byte. Its opaque artifact ID is
`00000000000000000000000000000001`. It produces exactly two fixed-name chunks and
the 299-byte index pinned in the checks record. Known digests are:

| Bytes | SHA-256 |
| --- | --- |
| First 16 MiB chunk | `d61744896212f04ac9995775ccebc979df4d04f99b6f64bfb012ef5ef436c251` |
| Final one-byte chunk | `4ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260` |
| Whole original | `36cc1f42062fe57caf7ce314090b0fdf4c6a652f8d8b616c544dfac47ed87f06` |
| Exact ASCII index | `34d476697a8fd67b567231cf1a48e4fd4eebf7beabe5037e423ca5178777db3c` |

This is a proposal, not an executed host pilot. Reserve its source/export/staging
and metadata explicitly; do not write it into the host's unknown free space.
The operator first names an **existing authorized binary file retrieval route from
pve2 to their workstation**. None is verified here. Console ownership alone does
not establish arbitrary file download, and no SSH, connector, new access or console
encoding workaround is assumed. If no such route exists, delivery stops at that
specific missing leg, before private originals or a live attempt.

After a separately reviewed setup, use that route for the three nonsecret files,
then manually attach them through the normal private upload interface. Supply the
expected inventory and index digest independently of those uploads. The assistant
retrieves all three, verifies exact inventory/offset/count/chunk/whole hashes with
the read-only receiver, and reports any missing or altered file. The 16 MiB chunk
size is below the currently reported 32 MiB attachment receiver ceiling; user-app
file types, batching and actual upload limits still require this pilot. Existing
local corruption/missing/extra-file tests support the receiver, not the transport.

The earlier 165-byte cross-executor cloud probe remains the only verified cloud
delivery fact. Even a successful proposed pilot would qualify only nonsecret
transport at that size, not authenticated guest-to-host acquisition, private or
full-profile delivery, source/custodian authenticity, physical lineage or live
receipt recovery. Uploaded bytes cannot recreate the original connected capability.

The next owner review should name the actual host root/principal/protection and
12 GiB quota feasibility, approve the finite raw/disposition/privacy policy, and
identify that existing binary retrieval route. These decisions precede host setup.
The technical 1 MiB clock restriction needs no further user decision. No host or
live operation, deployment, metadata write, new authority or launch override is
authorized by this source deliverable.

## Source verification

The [checks record](source-byte-bounds-and-delivery-profile-checks.json) identifies
the exact source/test bytes and log digests. The final focused selection passed
185 tests in 0.632 seconds and the same 185 tests under optimized Python in 0.781
seconds. The explicit non-live selection passed 622 outer tests plus seven
historical child tests in 32.012 seconds (child 7.198). The historical refresh
verified 69 separate harness/reference files were disjoint from 199 exact protected
Git inputs before copying. No full discovery, tracer/probe call or observation
launch body was executed by the new tests.

An initial command mistyped the qualification-boundary module name: 92 tests passed
and one import errored. The corrected selection passed 99 tests before the final
185-test selection above. The error and log digest remain in the checks record;
it required no executable fix. Ten Python files compile and diff checks pass.
The three existing diagnostic fixture updates use actual five-field pin metadata,
valid sample rows and the new bounded own-stat seam. The custom identity fixture
now checks early fixed-type refusal before its untrusted iterator can execute,
while preserving the existing cleanup assertions.


Independent **gpt-6.1-sol, xhigh** review compared all ten frozen source/test/selector
hashes, the complete delta and five retained root log/inventory hashes. It
independently passed 115 isolated tests normally in 0.301 seconds and under optimized
Python in 0.311 seconds, with no skips. It also checked the 69 historical harness/
reference copies and all 199 protected Git inputs, sizing equations and pilot
digests. The review found a custom-key equality path before discriminator
validation; strict builtin-key validation now closes all five affected paths and
a collision regression verifies refusal before custom equality executes.

No remaining finding exists within the documented stopped-owner/cooperative-process
and trusted local procfs/ancestor model. The review does not claim hostile
same-account isolation, installed clock compatibility, complete acquisition, host
setup, private transport qualification or live readiness. Ordinary CI is separate
evidence and does not run the mandatory Python historical fixture.
