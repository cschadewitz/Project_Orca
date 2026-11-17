# Windows diagnostic key durability — 9 October 2026

The first-profile crash failure is a real dependency in the previous production
key adapter, reproduced by the corrected same-profile harness. It is not cleared
by flushing the diagnostic wrapper alone. Windows now writes a self-contained
current-user DPAPI wrapper and retains read support for preserved Electron `v10`
wrappers. Diagnostics capture remains disabled.

The later combined source corrects a separate raw-key/envelope integration mismatch;
see [the envelope composition correction](windows-diagnostic-envelope-composition.md).
The pinned native probe below uses raw 32-byte material on `24cf52d`, and does not
verify the corrected envelope-sized native candidate. Its evidence bytes remain intact.

## Source and root cause

Implementation source: `24cf52dc18f97f981cafcdc8e71d640e8672de8c`, tree
`00de979fa2dccb632d50fe39bee161f4e85685ee`. Its parent is #584's privacy fix
`dccde5ddd8a0539827a194ccdd882c718745c9ce`, which retains composed source
`88fc825daaa969675d4d6d06931bceb00ebbacec` and Windows #585
`455ac202f7afa00da17dd91a595988b0250003a9`. Author and committer are Calcifer
Schadewitz <347762766+calciferschadewitz@users.noreply.github.com>.

Electron 44.4.5 constructs its Windows async DPAPI provider with Local State
preferences and commits pending preferences during normal shutdown. Its pinned
Chromium provider imports `os_crypt.encrypted_key` from those preferences; it
does not make a wrapper self-contained. The public async API exposes no durable
Local State commit barrier. References:
[Electron browser process](https://github.com/electron/electron/blob/v44.4.5/shell/browser/browser_process_impl.cc),
[pinned DPAPI provider](https://github.com/chromium/chromium/blob/152.0.7977.130/components/os_crypt/async/browser/dpapi_key_provider.cc),
[safeStorage API](https://www.electronjs.org/docs/latest/api/safe-storage).

The bounded control wraps and flushes 32 synthetic bytes in a fresh app profile,
then signals completion. The producer is killed and observed exited before a
new process reads the same profile. At the completion signal no profile Local
State encryption key is on disk. Restart invokes native `decryptStringAsync`,
whose promise rejects before application format/rotation checks. Normal
same-profile initialization passes. This supports the precise diagnosis: async
encryption completion plus wrapper fsync did not establish durable provider-key
authority. The historical different-profile/immediate-exit harness refusal is
preserved and is not used as crash evidence.

## Exact change

- `keys-windows.c` adds asynchronous `CryptProtectData`/`CryptUnprotectData` to the
  existing storage addon. The OS uses the current user; `CRYPTPROTECT_LOCAL_MACHINE`
  is never set. UI is forbidden. A fixed public domain separator distinguishes
  diagnostic key material; it is not a secret or another key authority.
- New wrappers contain the version header `ORCADP01` and the DPAPI blob. Only
  32-byte diagnostic keys are admitted, the entire wrapper is bounded to 4096
  bytes, and native dispatch snapshots the input before worker execution.
  Native copies and OS outputs are zeroed and freed after completion. At most
  four native key jobs may be outstanding.
- The Windows initializer loads that capability only from the existing fixed
  storage-addon location. Missing/incompatible addons refuse. macOS retains its
  existing async safeStorage path. Shared main/preload/Workspace files are untouched.
- Preserved `v10` wrappers still decrypt through their original Electron profile
  authority. Missing keys, provider rotation, malformed headers and native failures
  remain refusals; no preserved wrapper is rewritten, reset or dropped. A damaged
  DPAPI payload is never retried with legacy decryption.
- Windows staging links Crypt32 and includes the new source in the package source
  digest. Both architecture checks reject a manifest after that source changes.

This removes the application-profile preference dependency from new wrappers.
It introduces no timer, normal-exit priming step, preference/key copying, local
plaintext key, application-generated wrapping key, or capture activation.
[Microsoft's DPAPI contract](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
defines current-user protection and authenticated blob handling. As with the
previous Windows safeStorage provider, this is not isolation from other programs
running as the same user.

## Evidence and review

Final pinned results are in [the closed evidence directory](../preparation/windows-cold-profile/).
The local task retains the complete modified launcher/child, GNU test binary,
build inputs and original README/manifest/results. Original owner evidence was
read and copied byte-for-byte; the original directory is unchanged.

- Exact existing Electron **44.4.5 win32-x64**, executable SHA256
  `bd14928e0728366fd3f41499cb398ff3f4304dab259a3e605077899a6f8c748e`.
- DPAPI first producer passes wrapper fsync, observed forced exit, same-profile
  restart, tamper refusal, and preserved Electron `v10` read. It succeeds with no
  Local State encryption key present at the first producer's completion signal.
- Exact native input bounds and the dispatch snapshot are exercised in Electron
  with synthetic buffers. The unchanged async cold control still refuses; its
  native API booleans and absent-key facts are retained.
- Compiled production initializer with absent fixed resources remains default off:
  enable/current/previous preview refuse; no diagnostic files, key calls, picker
  calls or BrowserWindow; cleanup pending is reported honestly.
- **55 tests pass across five focused files; one Linux syscall case is skipped on
  Windows.** Root TypeScript, app project-reference compilation, scoped lint,
  Prettier and whitespace checks pass. No broad suite, coverage, installation or
  lockfile change. Scoped lint used the repository's unchanged rules with explicit
  paths into existing read-only dependencies because the inherited package links
  did not resolve through the isolated worktree.
- GNU C11 `-Wall -Wextra -Werror` compilation passes. The exact Electron binary's
  exported Node-API symbols supplied a test-only GNU import library. The resulting
  addon is explicitly injected into the conformance factory; it is never staged
  as production, copied into Electron resources, or accepted as an MSVC artifact.
  Self-review covered provider scope, strict format routing, refusal preservation,
  native bounds/copy/wipe lifetime, fixed-path loading and source-digest coverage.

## Remaining native gates

This proves the bounded current-user key adapter, not full diagnostic recovery or
packaged acceptance. Microsoft admin/license setup is still Casey's step; no
installer was launched. Production MSVC x64/arm64 staging and packaged exact
Electron loading remain unrun, and ARM64 runtime execution remains unproved.
Different-user refusal requires another already-authorized user session. Provider
rotation, physical power loss/sleep/hibernate/reboot/expiry, the post-rename crash
seam, paired resource/latency and 4 ms/8 MiB/combined 32 MiB gates, packaged traffic,
Windows accessibility and independent integrated acceptance remain open. No
account/access/security-setting change, CI dispatch, merge, main-target publication,
signing, release or installer interaction occurred. No milestone is closed here.
