# Host report custody and evidence delivery

Source baseline: `61484825c961d21b4c49c5326fe7f9167a7dab81`, draft PR #809.
Casey selected a small controller on **pve2**, operated through the existing
console, with private host evidence outside guest snapshots. Acceptance is
conditional on evidence sufficiency. This authorizes design/source work only.
Host disk failure remains evidence loss; this design supplies no independent
backup. No host, SSH, VM260, pve2, deployment, credential, access, security-setting
or observation action is authorized or performed by this increment.

## Named obligation and source component

The component is a native host-side **single-report custody transaction** toward
G4/S4–S9 and G7: reserve actual file capacity before a delegate, bound the copy,
retain original owned resources, publish without replacement, acknowledge after
sync, and preserve uncertainty after a failed or lost reply. This is a real file
protocol for a future controller, tested on isolated local files, not an issuer
specimen or a substitute authority object.

It handles one existing report artifact under the unchanged **1 MiB REPORT_LIMIT**.
It adds no observation journal, record kind, receipt field, session grant or launch
API. Original metadata remains separately 1 MiB plus separately accounted immutable
hex; trace remains 256 MiB; runtime count/per-asset bounds and the restrictive
512 MiB raw-source aggregate remain unchanged. All four observation entry refusals,
image/source pins, report whitelist and timeouts remain unchanged.

The later trusted console controller supplies an already-open private-directory
FD. Native FD/mode/ownership checks establish resource correspondence and access
mechanics; they do **not** authenticate Casey, authorize observation, prove hostile
same-account isolation, or establish a trusted installed controller. The operator's
host login, protected source installation, exact principal, fixed private root,
parent-directory protection and inheritance policy remain setup inputs. A candidate
in the guest must never receive this root FD, host path access, management channel
or controller credentials. No MCP/CLI workflow credential is relabeled as a session
issuer, and no JSON/callback success can bind this component to pve2.

The reservation uses one preallocated report inode. Pending and final hard-link
names refer to that same inode, not two report payloads. The host owner must still
allocate filesystem metadata and an aggregate attempt quota; a per-file bound is
not host-wide admission or disk-space accounting. The retained pending/final
aliases have link count two; the guest's original `evidence_seal` requires an
unaliased file with link count one. This host byte copy therefore cannot substitute
for guest physical lineage or the original in-memory receipt. No checker is changed.

The byte/resource bound is not a native filesystem I/O deadline. Host filesystem,
I/O-deadline and surviving recovery behavior still need qualification; no new timer,
pooled timeout or bound on kernel-call completion latency is introduced.
Installation and actual host reservation stop until those decisions are reviewed. Source tests use only owned
temporary directories and the existing per-report ceiling.

## Native report protocol

`HostReportCustody` acquires nothing in its constructor and issues no authority.
Its caller retains the original owner before `reserve()` has effects. Reservation
duplicates the supplied directory FD, checks the private directory's identity,
mode and native access, and creates the lane's fixed pending name exclusively.
Actual `posix_fallocate` reserves 1 MiB; file and directory sync precede the local
reserved outcome. Unsupported allocation or failed/uncertain acknowledgment
refuses; there is no sparse/memory fallback or replacement attempt.

`publish()` consumes one attempt. It accepts a real regular read-only source FD,
its preopened directory, exact size and SHA-256. Those scalar values identify
bytes and confer no permission or provenance. A complete bounded hash and physical
correspondence check precede the first payload write. Reads/writes use at most
65536-byte chunks; positive short writes continue the same write, while invalid
progress or any exception makes uncertainty absorbing. Source and destination
correspondence and digest checks repeat around the copy.

The same destination inode is truncated to the exact source length, restricted
to read-only mode, synced, and its writable/source handles consumed before
create-only final-link publication. Directory sync precedes the original owner's
local acknowledgment. Fixed pending/final names are:

| Lane | Pending name | Final name |
| --- | --- | --- |
| bootstrap | `.bootstrap-attempt.json.pending` | `bootstrap-attempt.json` |
| connected | `.connected-attempt.json.pending` | `connected-attempt.json` |

Both aliases are retained after success, with link count two and a single data
inode; no delete, replacement or repair API exists. A collision cannot overwrite
another record. Any partial, failed or lost-effect outcome retains the original
private exception and uncertain artifact for the surviving caller. Public errors
are fixed text/codes without exception formatting, paths, FDs or payloads. Handle
slots are consumed before close, so a possibly reused numeric FD is never retried.

`reconcile()` reads bounded snapshots through the retained root. The original
surviving owner may compare its retained inode/expected digest and remember an
acknowledgment it actually completed, without repeating publication. A fresh
inspector is permanently read-only and cannot recover original association or
acknowledgment from visible bytes. Neither outcome is acceptance, process settlement,
durable-media proof or a reconstructed connected receipt. A close or new read
failure is still uncertainty, even after a historically completed acknowledgment.
The caller's borrowed directory/source descriptors are never closed by this owner.

## What evidence this does and does not deliver

A report alone cannot establish complete replay. The required packet still needs
original trace bytes, canonical original packets, source/runtime/image associations,
phase/clock observations, private diagnostics where required, and original settlement
and bootstrap/connected correlations. The actual original closed supervisor must
retain its in-memory receipt/image/process graph across the two separately authorized
lanes. Uploaded artifacts are bytes; they cannot export, restore or recreate that
capability after process/guest restart.

The controller direction does not yet provide an authenticated guest-to-host
transport, a VM-generation binding, an issuer grant-consumption/revocation protocol,
a surviving recovery service, preventive isolation or loaded-code closure. These
remain distinct M1/Exit A–D obligations. This report-custody subcomponent closes no
full G1/G4 readiness gate by itself and supplies no current-image qualification.

For each future original, the required delivery chain is:

1. **Acquire in the guest:** the separately authorized original observer acquires
   complete bounded originals under preventive isolation and its reviewed code
   origin. Current launch refusals still prevent this step.
2. **Transfer guest to host:** a specifically reviewed owner-controlled transport
   must bind the exact original attempt, guest generation, artifact identity, size
   and whole SHA-256. Console availability alone is not a binary-transfer protocol.
   No SSH, shared host mount, new credential, arbitrary listener or ambient account
   fallback is assumed or implemented here.
3. **Retain on host:** the controller's private destination lies outside guest
   rollback. Each artifact needs acknowledged reservation and publication, fixed
   capacity, original ownership and no blind retry on lost acknowledgment. The
   new component covers the report-file mechanism only; larger originals and the
   complete attempt inventory still need the same reviewed owner accounting.
4. **Approve disclosure:** before any run/export, the owner must review exactly
   which complete originals may leave private custody and which private paths,
   disposable auth tokens, keys or other data they contain. Required raw bytes
   cannot be silently redacted and still claimed as exact replay evidence. Safe
   summaries are useful orientation, not substitutes for full raw replay. No raw
   token, key, secret, unreviewed trace or archive is uploaded by this work.
5. **Deliver to assistant:** Casey may manually upload only the approved files to
   the conversation/Library. Tools support retrieval of user attachments and
   materialization of identified Library files. There is no verified pve2
   filesystem/SSH connector and no automatic host pull. This user-mediated leg
   still needs an actual setup test from the selected host and upload surface.
6. **Verify bytes after receipt:** require the complete index, each chunk's exact
   length/offset/hash and the reconstructed whole-original hash. Missing, duplicate,
   reordered, changed or truncated data refuses qualification. Upload success or a
   display summary is insufficient; actual retrieved bytes must verify.

## Receiver bounds and export accounting

The parent inspected the supported attachment download helper and reports a
**32 MiB per-file receiver bound**. Library materialization offers a different
transfer route; its available tool schema does not document the user application's
upload limit. Neither statement proves a tested pve2-to-assistant path.

A **proposed**, not implemented or approved, export plan uses digest-indexed chunks
of at most **16 MiB**, below that receiver bound, plus exact whole-original hashes.
This is a transport proposal, not a changed observer/artifact limit. The owner must
approve privacy, metadata format and quota before any chunk/index writer is added.
No unreviewed archive or extra journal allocation is introduced here.

For an original of size B and chunk ceiling C, N = ceil(B/C), and the sum of chunk
payloads must equal B. Keeping every chunk alongside its original requires at least
B original + B export payload bytes, plus explicitly counted index, filesystem
metadata and transfer staging. Streamed one-chunk export could reduce simultaneous
export payload to min(B,C), but needs an owner-approved retention/ack protocol and
must not delete uncertain or sole evidence. It is not an automatic cleanup option.

Existing per-lane maxima for just the three large artifacts are:

- Canonical originals: at most 2 × 512 MiB raw-source ceiling + 1 MiB metadata,
  i.e. **1025 MiB** serialized bytes.
- Trace: **256 MiB**; report: **1 MiB**.
- Sum: **1282 MiB per lane**, before diagnostics, clock/helper outputs, compact
  association, filesystem metadata, the other lane, retention and any export copy.

This is an accounting expression, not an approved host reservation. In particular,
there is no new 1 MiB journal allowance and no spare trace/report capacity to borrow.
A complete finite artifact inventory and existing host allocation must precede
attempt admission. If the full packet cannot fit the owner's allocation, admission
remains unavailable rather than silently increasing a bound or dropping originals.

## Tiny cloud-only delivery probe

A fixed **165-byte nonsecret text file** was saved successfully to Library:

- Library ID: `libfile_118352ba0c8881918063f24d13cc1852`.
- File ID: `file_0000000048b48230955c59f1ae5c3fd2`.
- Filename: `orca-custody-cloud-probe.txt`.
- SHA-256: `0b13608eccc53b041b5a3967dda59501992cc843b8eb4537d953d99932d739ad`.

The supported Library materialization call returned a transfer, but the required
transfer helper failed with fixed text `library file transfer failed: download failed`.
No retrieved bytes were created. That transfer was not retried or routed around;
retained cloud network diagnostics contained no explanatory record. Therefore this
local attempt alone confirmed cloud upload/retention only. A subsequent independent
parent-side consumer successfully materialized the exact native Library/file IDs
through the supported route in another executor, applied attributes, and verified
all 165 readable bytes against the same SHA-256. That establishes **cross-executor
cloud-file-to-assistant bytes** for this fixed nonsecret small file. It does not
qualify pve2/guest transport, the user-upload leg or limits, large/private evidence
transfer, original physical continuity or live authority. The original local
materialization failure remains recorded separately. This file contains no private
evidence, token or capability. No transient transfer URL/token or consumer-local
path is included in public evidence.

## Next setup decision and stopping condition

Before applying anything, Casey reviews a concrete setup packet naming the host
principal and protected installed source, exact private root outside VM rollback,
existing disk/metadata/aggregate reservation, original attempt and lost-reply owner,
allowed management/guest transport, privacy-reviewed complete artifact list and
manual export route. No new account/access or host security relaxation is assumed.
The proposed packet must distinguish source behavior, documented host setup and
later measured qualification.

The next substantial source step after this transaction requires that owner binding
and capacity/export decision. No guest run, session issuance, new journal, raw export,
host mutation or automatic retry follows from this source increment or the probe.
The held PR-metadata write, App Smoke prohibition and prior failed evidence remain
preserved. Exact code/tests/review and CI results are reported separately below.


## Final source verification and independent review

The [checks record](host-report-custody-checks.json) identifies exact candidate
source/test/selector hashes and test-log digests. Final primary results:

- **36 focused tests passed** (29 custody + seven qualification boundaries),
  0.242 seconds; **29 optimized custody tests passed**, 0.066 seconds.
- Explicit non-live selection: **556 top-level plus seven historical child tests
  passed**, 25.680 seconds (historical child 6.282 seconds). The mandatory fixture
  retained exact SOURCE and dependencies; 65 current harness/reference files were
  verified disjoint from 199 protected historical Git inputs before copying.
- Changed Python files compile; JSON formatting and `git diff --check` pass.
  No full Python discovery or real-tracer cases ran. Ordinary CI is separate.

Independent **gpt-6.1-sol, xhigh** review inspected the complete module, tests,
selector and evidence. It found and resolved a nonblocking FIFO read-open gap;
original process/exact-thread binding and post-hash destination correspondence
were also hardened before the final freeze. Its final independent normal run
passed 36 tests in 0.226 seconds, and optimized run passed 29 in 0.072 seconds.
No remaining source finding was identified. Host installation, actual custody
isolation, media durability, kernel I/O deadlines, complete-packet delivery and
issuer authentication are still unqualified. No formal security approval follows.


Subsequent [complete-original inventory and read-only receiver work](complete-originals-receiver.md)
adds real independently expected chunk/whole-byte verification without writing
export or reconstructed payload files. It identifies uncapped clock-helper bytes
and diagnostics' missing serialized cap instead of pooling existing allowances.
It does not extend the single-report component into full source qualification or
an approved host exporter; all installation, quota and privacy decisions above
remain open. Earlier test/error/probe records remain separate dated evidence.
