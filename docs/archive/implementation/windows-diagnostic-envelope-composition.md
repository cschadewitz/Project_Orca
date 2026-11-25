# Windows key envelope integration correction

Pinned #588 `3185dd29b50fc5bab02a54f901c5e26bca243acd` is retained without
squashing. Its source `24cf52dc18f97f981cafcdc8e71d640e8672de8c` fixes the
first-profile Local State durability dependency for raw 32-byte probe material.
Integration review found a separate production contract mismatch: `NodeRecoveryDisk`
passes a JSON envelope containing purpose, epoch, key ID, session ID and key to
`DiagnosticsKeyAdapter.wrap`. The preserved Electron wrappers also contain that envelope.
The new adapter's exact 32-byte restriction refused both actual production paths.

The correction accepts the established opaque plaintext limit, 1–2048 bytes, in
both native protection and JS unwrap. The native input copy, four-job limit,
current-user scope, forbidden UI, domain separator, zeroing and async completion
are preserved. The DPAPI blob stays bounded to 4088 bytes and the versioned wrapper
to 4096. The disk retains its existing strict envelope authentication/structure
checks. No caller converts the envelope to a bare key or drops its metadata.

`ORCADP01` continues routing only to DPAPI. Preserved `v10` data continues through
the original Electron profile authority; rotation/unavailability refuses. No
damaged new wrapper falls back to legacy, no preserved file is rewritten and the
Mac safeStorage implementation is unchanged. Diagnostics remain disabled.

## Focused evidence and reuse

Both new integration regressions failed against the original pinned #588 adapter
with `unavailable`: a real disposable `NodeRecoveryDisk` control/session flow and
a preserved `v10` envelope read. They pass with the corrected contract. Two later
test-only fixture expectations were corrected: the prior helper intentionally
wrote a second checkpoint and rotated the slot. The final regression retires its
writer directly and checks the original control/session bytes after recovery.

The final combined source selection passes 83 tests in five files: configuration
security 20, actual main 25, real closed CLI bootstrap 5, Windows key routing 17
and actual packaging 16. Four additional plaintext-bound cases and the new real
disk case pass separately (41 other cases excluded by that name filter). This is
88 distinct passes in six files; repeat invocations are not added.

Reuse #587's 315 pinned cases outside the overlapping configuration/main/CLI
boundaries and #588's 55 cases within their stated scope. Its actual Electron
44.4.5 x64 GNU probe demonstrates raw-key DPAPI durability on the old native
source; it does **not** verify this corrected envelope-sized native candidate.
The existing evidence files and hashes are retained unchanged. Source-only
controlled envelope checks are not a fresh DPAPI/MSVC/packaged acceptance claim.

Root and renderer TypeScript, scoped lint/formatting and whitespace checks pass.
No Windows compiler is installed in this Linux verification environment. The
two native bounds changes need the Windows owner's rebuilt/probed exact candidate;
MSVC x64/arm64, packaged Electron, second-user, resource and physical/accessibility
gates remain open. No toolchain install, account/security change or workflow run occurred.

The LF checkout's five-input Windows source digest is
`41f7daf2e53d6ab8e233469ded0537d21e86485ffd2d5a616dd9351c17606a12`.
The source digest includes binding.gyp, clock.c, storage-windows.c, keys-windows.c
and windows-delay-load.c. The shared binding.gyp also changes the Mac source
manifest digest, so previously staged manifests must be rebuilt from the
acceptance checkout. Do not substitute this LF digest into a Windows CRLF manifest.
The final immutable combined head/tree is recorded in #584 metadata.
