# Export-cleanup correction for #470: decision packet

4 October 2026; responds to [review items 1 and 2](https://github.com/cschadewitz/Project_Orca/pull/470#issuecomment-5976309663)
on `026e217e9efd32bb587bdc7c7ca5d97ab9007357`. **Proposal only; Casey and Cal's
technical/privacy review remains required before these paths are implemented.**
The task follow-up approves reboot-limited recovery; that choice is not reopened.
No runtime code, activation, peer implementation import or native acceptance is added.

## Smallest viable alternatives

| Design | Benefit | Cost / decision |
| --- | --- | --- |
| RC1: destination-adjacent temp and encrypted locator | Can stage beside the selected destination | Needs retained control key after opt-out; key loss can strand plaintext. Reject as the recommended design. |
| Fixed private app-owned slot, same-filesystem native no-replace move | Bounded discovery without a diagnostics key or private destination locator; preserves exact reviewed bytes | Restricts supported destinations; native atomicity/path/identity proof still required. **Recommend.** |
| Native unnamed/delete-on-close staging | May remove crash cleanup state where publication from the handle is supported | No established common Mac/Windows publishable-handle adapter; transferring ownership must not delete the user export on close. Defer pending separate proof. |
| Direct final-file write or external unencrypted path journal | Avoids the old encrypted locator dependency | Direct write exposes partial user files; path journal retains private destination data. Neither meets this correction's constraints. |

Recommendation: replace only export staging/discovery and correct ordering prose.
Keep encrypted capture, key separation, exact-content preview, explicit final Save,
all existing budgets and the no-overwrite/no-user-export-deletion rules. Refuse an
unsupported destination before plaintext creation. No cross-volume copy/delete,
destination-adjacent fallback, delayed OS deletion, directory scan or permission repair.

Native research supports investigation, not implementation approval: Apple's
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
contains only version, opaque operation ID, phase and local staging identities: no
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
| Successful cleanup | After writers settle and verified staging removal is confirmed, report temporary cleanup complete separately from keys, durable opt-out and publication outcome. Delete cleanup metadata only when its outcome obligation is settled. |

No diagnostics key is deliberately retained solely for export cleanup. This does not
promise instantaneous zeroization: live native operations, failed wrapper deletion,
backups and runtime copies have the existing disclosed limits. Plaintext may survive
while ORCA is closed or cleanup fails; no physical/forensic erasure is promised.

The minimal proposal deliberately leaves an unknown post-crash publication blocking
another Save, even when staging cleanup succeeds. Do not clear that block by opt-in,
restart, timeout or a missing file. Supporting user-assisted reconciliation/reset would
need a separately reviewed extension; do not silently add persistent destination paths.
This availability limitation is part of the owner decision, not a claim of full recovery.

## Bounds and observable ordering

Retain the 4 MiB encrypted workspace/control allowance plus at most one 1 MiB export
slot: 5 MiB total unsaved owned logical bytes. Cleanup metadata and its replacement
copies together consume at most 8 KiB of the existing 64 KiB control allowance. Count
all files, staging directory and replacement entries within the existing 16-entry
ceiling. At most one Save, one staging payload and one cleanup operation; no generational
accumulation. Unknown/oversized/unsafe remnants block allocation, not accounting.
Memory remains within the contract's existing 8 MiB controlled-payload ledger and
32 MiB measured target. Neither is newly measured here.

Failed cleanup and unknown publication retain full reservations; a timeout does not
free the native slot. One bounded startup cleanup attempt and explicit retry only.
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
| Crash after possible publication with missing stage | Publication stays unknown despite successful staging cleanup; no final-file deletion, destination search or blind retry. |
| Packaged Mac and Windows, another ordinary OS account | Restrictive rights before first byte, cross-account read/write denial, ancestry/identity and no-replace race tests; actual filesystem behavior, not Node mode bits or Linux mocks. |

## Decision requested before implementation

Casey and Cal: review the fixed private slot, no cleanup-key retention, same-filesystem
Save restriction, bounded unencrypted identity record, residual plaintext cleanup risk,
and conservative unresolved-publication block together. The dispatch consistency fix
addresses contradictory prose; implementing the associated paths remains gated. Keep
#416, technical/privacy review and fresh independent/native acceptance open.
