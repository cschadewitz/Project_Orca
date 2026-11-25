> Decision 9 (4 October 2026) and the current implementation instruction supersede any pending-owner-review wording below for fixed private plaintext staging, same-filesystem no-replace destinations, content-free key-independent metadata and visible residual plaintext cleanup failures. Acknowledged summaries are removed on opt-out after cleanup completes; unresolved obligations remain until safely resolved. Native/independent acceptance remains separate.

# Export-cleanup correction for #470: decision packet

4 October 2026; responds to [review items 1 and 2](https://github.com/cschadewitz/Project_Orca/pull/470#issuecomment-5976309663)
on `026e217e9efd32bb587bdc7c7ca5d97ab9007357`. **Decision 9 approves the bounded disabled implementation; independent technical/privacy review and native acceptance remain required before activation.**
[Decision 7](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976357825)
approves reboot-limited recovery; [decision 8](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976828540)
approves bounded explicit Save again after an unknown result. Neither choice is reopened; decision 9 approves the final storage/exposure mechanisms within their recorded bounds.
The disabled implementation follows this accepted contract; native acceptance and production activation are separate.

## Smallest viable alternatives

| Design | Benefit | Cost / decision |
| --- | --- | --- |
| RC1: destination-adjacent temp and encrypted locator | Can stage beside the selected destination | Needs retained control key after opt-out; key loss can strand plaintext. Reject as the recommended design. |
| Fixed private app-owned slot, same-filesystem native no-replace move | Bounded discovery without a diagnostics key or private destination locator; preserves exact reviewed bytes | Restricts supported destinations; native atomicity/path/identity proof still required. **Accepted in decision 9.** |
| Native unnamed/delete-on-close staging | May remove crash cleanup state where publication from the handle is supported | No established common Mac/Windows publishable-handle adapter; transferring ownership must not delete the user export on close. Defer pending separate proof. |
| Direct final-file write or external unencrypted path journal | Avoids the old encrypted locator dependency | Direct write exposes partial user files; path journal retains private destination data. Neither meets this correction's constraints. |

Accepted design: replace only export staging/discovery and correct ordering prose.
Keep encrypted capture, key separation, exact-content preview, explicit final Save,
all existing budgets and the no-overwrite/no-user-export-deletion rules. Refuse an
unsupported destination before plaintext creation. No cross-volume copy/delete,
destination-adjacent fallback, delayed OS deletion, directory scan or permission repair.

Native research guides the approved design; it does not establish adapter conformance: Apple's
[XNU headers](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/stdio.h)
expose `renameatx_np` and `RENAME_EXCL`; Microsoft's
[FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)
describes no-replace behavior and directory-relative naming. Neither source proves
our packaged adapter's atomicity, supported filesystems or race resistance. Windows
[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
also documents creation security and delete-on-close; a flag alone does not establish
safe publication/ownership transfer. Native tests must establish the whole operation.

## One operation, durable state and identity

Use one fixed export-staging subdirectory under the private app profile, separate
from encrypted checkpoints, containing at most one plaintext staging file. One
profile coordinator owns the operation; no inherited worker handle or second writer.
Before any bytes, verify restrictive directory ancestry and owner-only POSIX access
or effective Windows DACL, reject links/reparse points and unsupported filesystems,
and reserve the entire operation. Never trust a picker path or a filename alone.

After explicit final Save, durably persist a bounded, owner-protected **key-independent**
intent record, then exclusively create an empty staging file with restrictive rights.
Verify native directory/file/volume identity, regular-file type and single-link state;
persist that identity before writing plaintext. Flush the exact frozen bytes and close
or retain only the handle required by the reviewed publication primitive. The record
contains only version, opaque operation ID, phase, local staging identities and the
contract's bounded acknowledged-unknown summary: no
report content, digest, key, boot/capture metadata or destination path. It is not a
checkpoint authority or a replacement for authenticated capture manifests. Filesystem
protection, not a retained diagnostics key, protects this cleanup-only record. A
same-user attacker or coordinated profile rollback is not defeated by this scheme.

Before native dispatch, durably mark publication as potentially dispatched, then
recheck all authority under the serialized gate. A crash between this marker and the
call is conservatively unknown; the marker never grants permission to retry. Destination
handles/identities remain in memory only. Publish by the verified same-filesystem
no-replace move; no generic replacing rename, hardlink/copy fallback or alternate stream.
Persist the terminal outcome before releasing the operation. Failure to persist it
retains the durable reconciliation block and reservation. Report a verified live
publication as saved; after restart, treat the uncommitted outcome as unknown.

Startup/off-state cleanup accesses only the fixed slot and bounded record. Validate
opened ancestry, owner/rights, volume/file identities and no-link constraints before
unlinking the staging name. Never truncate it, follow it elsewhere or delete a final
export. Missing, malformed or contradictory identity state fails closed. An interrupted
empty-file creation before identity recording may therefore require manual support;
no report plaintext was authorized at that boundary. After the dispatch marker, missing
staging does not prove success or failure. Without a live verified destination, report
unknown and do not scan or reconstruct a destination path.

## Keys and data surviving failures

| Event | Surviving keys/data and permitted action |
| --- | --- |
| App crash before dispatch | Under unchanged opt-in, OS-wrapped session keys and control-authentication key follow the recovery contract. The one staged plaintext file and cleanup-only record may survive; cleanup validates the fixed slot without unwrapping any key. It never resumes Save. |
| Session data key loss/unavailability | Affected encrypted reports cannot be opened. Their ciphertext/wrappers remain only pending safe deletion; the separate control key may still exist under valid opt-in. Staging cleanup does not depend on either key. |
| Control key loss/unavailability | Capture manifests lose authority; refuse recovery. Session wrappers/ciphertext may remain pending cleanup. Fixed-slot export cleanup still uses filesystem identity; no replacement key is created over old state. |
| Opt-out | Immediately revoke logical authority and persist disable/revocation per contract. Drain/fence existing work and attempt deletion of both session and control wrappers without waiting for export cleanup merely to preserve its locator. Failed wrapper unlink or unsettled key work is reported as key cleanup pending. No new key or intentional cleanup-key retention. |
| Failed staging unlink / unsafe or moved root | At most the reserved staging payload and bounded record remain; key deletion proceeds independently. Show cleanup pending, retain reservation, block new Save and old-state reuse; no search, forced access or automatic repair. |
| Timeout / interrupted publication | Retain operation slot and reservations; an already-dispatched call may complete later. A crash can leave a published user file or staging plus the record. Report unknown until evidence resolves it; never delete the user file or infer “nothing saved.” |
| Successful cleanup | After writers settle and verified staging removal is confirmed, report temporary cleanup complete separately from keys, durable opt-out and publication outcome. Retire current cleanup identity only after its outcome is known or its still-unknown result is explicitly acknowledged under the contract; preserve the bounded unknown summary. |

No diagnostics key is deliberately retained solely for export cleanup. This does not
promise instantaneous zeroization: live native operations, failed wrapper deletion,
backups and runtime copies have the existing disclosed limits. Plaintext may survive
while ORCA is closed or cleanup fails; no physical/forensic erasure is promised.

## Approved acknowledgement replaces the indefinite block

The [authoritative state-transition contract](integration-contract.md#acknowledge-unknown-outcome-and-save-again)
specifies decision 8 for the disabled runtime implementation. Compared with `edb66b4`'s
indefinite block, acknowledgement can remove only the new-Save admission block; it
never establishes the previous publication result.

| Stage | Rule |
| --- | --- |
| Unknown, old work or staging unresolved | Block acknowledgement and new Save, hold reservations; timeout/missing file/user click proves nothing. |
| Unknown, proven no future old writes and verified cleared staging | Show the previous-export warning and enable explicit acknowledgement, still no Save. |
| Durable acknowledgement committed | Keep prior result unknown, release only cleared old resources, invalidate old destination/save tokens; no automatic picker, Save or consent. |
| Separately authorized new Save | Current valid exact preview, fresh picker/token, currently nonexistent filename, separate final Save, fresh operation ID, atomic no-overwrite. Keep possible earlier exports untouched. |

One latest acknowledged-unknown summary plus a boolean for older unknowns replaces
unbounded per-operation history. It shares the cleanup envelope and existing byte/entry
budget. No old destination paths or report data; the UI discloses that only the latest
unknown has detail. The contract specifies durable replacement, acknowledgement failure,
crash recovery, callback fencing and repeated-click idempotence. Decision 9 permits bounded summary retention across restart and requires its removal on opt-out only after cleanup completes. Unresolved obligations must not be discarded.

## Bounds and observable ordering

Retain the 4 MiB encrypted workspace/control allowance plus at most one 1 MiB export
slot: 5 MiB total unsaved owned logical bytes. Cleanup and acknowledgement metadata and all replacement
copies together consume at most 8 KiB of the existing 64 KiB control allowance. Count
all files, staging directory and replacement entries within the existing 16-entry
ceiling. At most one Save, one staging payload and one cleanup operation; no generational
accumulation. Unknown/oversized/unsafe remnants block allocation, not accounting.
Memory remains within the contract's existing 8 MiB controlled-payload ledger and
32 MiB measured target. Neither is newly measured here.

Failed cleanup and unknown publication retain full reservations until either a known
outcome is safely settled or the contract's explicit acknowledgement commits after
writer cessation and verified staging cleanup. A timeout never frees the native slot. One bounded startup cleanup attempt and explicit retry only.
No execution locks, key prompts on the execution path, uploads or raw diagnostics logs.

- Revocation before native dispatch prevents publication, including after intent or
  staging write. Drain writes before cleanup; report cancellation and cleanup separately.
- Dispatch before revocation leaves a pending outcome. Late success says the earlier
  Save completed; preserve its user-owned file. Late failure reports its actual outcome.
  Neither restores capture, preview or Save authority.
- Unknown completion reports unknown, never canceled/saved/“nothing saved” by inference.
  No completed overall cleanup while a stale write can still appear.

## Fault and native evidence plan

These are planned assertions, **not executed acceptance tests**. Use synthetic content,
one bounded worker and disposable profiles; record exact implementation SHA and native
OS/build/filesystem. The existing six helpers only test orchestration/fixture plumbing.

| Fault / boundary | Required evidence |
| --- | --- |
| Kill before/after intent, empty creation, identity commit, plaintext write/flush, dispatch marker, native call and terminal record | Bounded leftovers; no plaintext before durable identity; safe key-independent cleanup or explicit pending; no automatic republish. |
| Remove/lock every session/control wrapper separately and together, then opt out/relaunch | Staging discovery requires no diagnostics key; both wrapper classes are deletion targets, never intentionally retained for export. Key and file failures shown separately. |
| Existing destination, symlink/junction/reparse race, moved destination or staging root, replaced file ID or extra hardlink | Refuse unsafe mutation; preserve unrelated/user files; no path-only deletion or scanning. Cross-filesystem/unsupported targets fail before plaintext. |
| Denied unlink, full disk, corrupt/oversized/missing cleanup record, interrupted record replacement | Full reservation remains charged; at most one slot, no new Save, accurate cleanup pending. |
| Barrier before and after dispatch; opt-out/expiry/window loss; timeout then late success/failure | Both ordering cases and exact-byte export; no restored authority, duplicated save, premature release or false cleanup success. |
| Crash after possible publication with missing stage | Publication stays unknown; missing stage alone permits neither acknowledgement nor new Save. With proven writer cessation, verified staging cleanup and durable explicit acknowledgement, permit only a separately authorized new operation. No final-file deletion, destination search or blind retry. |
| Crash before/after acknowledgement replacement, reservation release and fresh intent | Valid predecessor or committed successor only; ambiguous state blocks; no automatic dispatch or duplicate release. |
| Repeated acknowledgement/Save, stale callbacks, expired preview, old picker token | Idempotent acknowledgement, one new operation at most, no renewed consent/preview; old result remains unknown. |
| Existing earlier export and filename collision during fresh publication | Earlier bytes remain unchanged; no-overwrite refuses collision; a newly selected nonexistent filename can succeed without resolving earlier unknown. |
| Many successive unknown outcomes | One current record and one latest unknown summary with olderUnknowns boolean, no per-event ledger; all copies fit 8 KiB/64 KiB/16-entry bounds; disclose compacted history. |
| Packaged Mac and Windows, another ordinary OS account | Restrictive rights before first byte, cross-account read/write denial, ancestry/identity and no-replace race tests; actual filesystem behavior, not Node mode bits or Linux mocks. |

## Decision 9 and acceptance handoff

[Decision 9](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5977241702) approves the fixed private slot, no cleanup-key retention, same-filesystem Save restriction, bounded content-free key-independent identity/acknowledgement records and visible residual plaintext cleanup risk. Remove acknowledged summaries on opt-out after verified cleanup; preserve unresolved obligations until safely resolved. The current task authorizes the disabled implementation. Native copy, identity, clock, key/ACL, process and resource proof remains required for activation, along with a fresh independent reviewer. #416 remains open.
