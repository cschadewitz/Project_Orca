# Windows native implementation and acceptance - 9 October 2026

This substantive follow-up to `6ff89c9d4f73352d6b41da4c342a36b6b5e153c4`
implements the Windows source gaps in #416/#469 on exact combined #584
`a991fbfea9da6d39dea2f0c513cc5a000d993c14`, preserving #574/#578 ancestry.
The [earlier evidence](windows-diagnostics-acceptance.md) remains historical evidence.
Production capture remains disabled by `DIAGNOSTICS_PRODUCTION_ENABLED = false`.
No acceptance issue is closed by this draft.

## Source delivered

- A Windows Node-API clock uses the kernel boot GUID and biased interrupt time,
  with fixed-size data and fail-closed capability/continuity checks. Two new owned
  processes agree on boot authority and advancing elapsed time; replacing `Date.now`
  does not affect it. Boot GUIDs are never committed. The elapsed-time choice follows
  [Windows interrupt-time semantics](https://learn.microsoft.com/en-us/windows/win32/sysinfo/interrupt-time).
- Async native storage traverses local NTFS directories by held handles. It refuses
  reparsing, hardlinks, ambiguous/device/stream names, broad existing private-root
  ACLs, unsafe ownership and unexpected ACE forms. Ancestors must have trusted
  ownership and no untrusted rights to mutate existing children/ancestry; private
  files/root have current-user ownership and allow only that user and SYSTEM.
  The fixed TrustedInstaller service SID is locally derived for ancestor checks.
  Existing security descriptors are never repaired. Only newly created app-owned
  test/product objects receive private descriptors.
- Exclusive `LockFileEx` writer ownership survives filename checks and excludes
  concurrent controllers. Buffers are borrowed into one async native job, with
  four file handles, sixteen entries, bounded files and at most 64 held ancestors.
  Native owned metadata has a compile-time 64 KiB bound. Metadata-only inspection
  reports a leaf reparse object without following it, preserving unsafe stages
  during opt-out. No Node path publication fallback exists.
- Save flushes the exact private stage and uses native handle-relative, same-volume
  rename without replacement. The selected destination ancestry remains leased.
  A collision leaves both the existing target and stage intact. Ambiguous native
  outcomes remain unknown. `FlushFileBuffers` does not establish physical power-loss
  or directory-entry durability; that gate is unrun. See
  [native rename information](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)
  and [flush behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).
- Restarted unknown-export acknowledgement now acquires the actual native lease
  before asking whether old writers have stopped. Process IDs, elapsed time or
  missing filenames never substitute for cessation. Cleanup works without history
  keys and with production capture disabled; it never changes unknown to saved.
- Closed source-owner producers cover connection availability/loss, verified protocol
  mismatch/authentication verdicts, dispatched admission uncertainty, validated
  recoverable admission failure, authorized resume failure and an explicit protected
  owner failure projection. Serialization failure is pre-dispatch and records no
  uncertain-admission fact. Observers cannot change owner control flow. No additional
  operation, RPC, store read, payload, identifier, error text or cause is collected.
- Windows x64/arm64 fixed external addon locations, PE architecture/source/byte
  verification and real builder before/after-copy checks are implemented. Both configured
  targets have explicit local-header/import-library staging in the ordinary manual/release
  packaging lane. Inputs are checked against official exact Node SHA256 entries.
  The installed MSVC/SDK is required; staging does not install a toolchain or download
  implicitly. A C delay-load hook resolves Node-API in the current host executable.
  No workflow was dispatched or rerun.

Shared main/preload/Workspace composition is not edited in this commit. The integration
owner receives [a narrow main-process patch](windows-integration-owner.patch), based on
the unchanged `a991fbf` main file. It typechecked temporarily against these sources and
passes `git apply --check`; it forwards current-client and already validated notification
facts plus application/power lifecycle facts. SHA256:
`640B3F0E3BC2C634D8E0999470D5698AA34F5BB02D3909F1FEFD521DF6AB73D5`.
The integration owner must apply/review this patch after taking the substantive commit,
preserve the disabled shipping gate, and verify the composed Electron lifetimes.

## Windows evidence

All native positive tests used fresh disposable directories under the current user's
Documents folder because the existing Temp/workspace ancestry grants a different local
principal mutation rights. Refusal there is intentional; no existing ACL was altered.
Every owned child exited before cleanup, and all positive fixture trees were removed.
Casey's checkout, agent-01, its daemon and shared desktop UI were untouched. Capacity
was checked first; original capacity/provenance remains in the historical report.

The installed GCC 12.2 x64 compiler compiled clock/storage/hook C11 with
`-O2 -Wall -Wextra -Werror`. Official Node 24.19.0 headers and import-library
downloads were verified against `https://nodejs.org/dist/v24.19.0/SHASUMS256.txt`:
headers `54f14a297d47ea0794fe272363703d9dc419c96ac68f20d890f98b63754a3e4c`,
import library `63ec831bbf164d1b23197d6fac1944dfb146534e332889ca0755d250e8dedff9`.
For the GNU Node-only probe, a bounded Node-API import archive was derived from the
installed exact Node executable exports. Its binaries have static `node.exe` imports;
they are not shipping Electron binaries. MSVC, SDK and an exact installed Electron
binary were absent, so the production delay-load build/load is explicitly unrun.

The [native matrix](native-packaging-evidence/windows-native-matrix.json) passes eleven
bounded case groups: cross-process clock/wall independence; private roots/exclusive
writer; unsafe inherited DACL refusal without repair; held ancestor swap exclusion;
hardlink refusal/preservation; root/leaf reparse refusal without following; closed names;
size/handle/close bounds; exact 1 MiB Save/no-replace/consent/destination ownership;
forced process exit after an 8,192-event checkpoint, recovery and opt-out; and interrupted
export cleanup with actual cessation, no keys and disabled capture. The export case
parks after durable dispatched metadata and before native publication, proves the
live writer blocks a second lease, then terminates it and acknowledges unknown only
after verified stage cleanup. An actual post-rename/pre-result crash is unrun.

The [real PE package probe](native-packaging-evidence/windows-native-package.json)
uses actual x64 DLL bytes and the actual builder copy engine/hooks. It verifies fixed
external Node-hosted loading, wrong architecture refusal and absent-resource refusal
without repository fallback. Synthetic PE fixtures separately cover both architectures.
Neither is a packaged Electron or native arm64 runtime claim. Final Windows source
digest: `5fe5178654fff7a2e3c0f799f5da07bbed738acd87d485ff2fca3939870aacd9`.

The [native resource workload](native-packaging-evidence/windows-native-resource.json)
has 8,192 current and 8,192 previous retained events, zero counted budget/expired/invalid
omissions, 959,527 exact saved bytes and opt-out preserving the user's export. It uses
real Windows clock/storage/controller and synthetic keys; the separate existing native
[CurrentUser DPAPI probe](native-packaging-evidence/windows-dpapi.json) remains limited
to its own verified results. Record maximum was 0.476 ms; phase callback maxima were
2.158 ms capture, 2.720 ms checkpoint, 2.435 ms previous preview, 2.485 ms current preview,
3.291 ms Save and 0.217 ms opt-out. Oracle/transition samples remain in the raw result.
Idle timer delay was 14.944 ms and active maxima reached 15.602 ms. Payload reservation
peaked at 4,194,304 bytes; sampled heap+external increment was 19,577,320 bytes and
RSS increment 22,790,144 bytes. Baseline is after initialization/promotion and already
includes the allocated ring. No paired execution, renderer, native allocation high-water
or hard memory bound was measured. These observations clear neither full Windows 4 ms,
8 MiB controlled allocation nor combined 32 MiB acceptance. The previously observed
Linux 1.7-2.6 ms is not used as Windows or memory proof.

Focused regression runs passed 126 cases (62 existing platform-specific skips), then
93 cases (46 skips), with overlapping suites and one worker. The latter includes actual
daemon-client/connection-client and final source producer corrections. Linux filesystem
conformance and POSIX compiler cases remain skipped on Windows, not counted as passes.
The final nine producer cases pass after lint/type corrections. The
[compiled disabled initializer](native-packaging-evidence/windows-compiled-native-refusal.json)
creates no diagnostic files and calls neither keys nor picker; inaccessible cleanup
remains honestly pending rather than falsely claiming deletion.
Root no-emit and project-reference compilation pass. Scoped lint/format, patch application,
privacy/evidence inspection and whitespace validation are recorded with the final commit.

## Remaining acceptance and exact owner steps

Non-Mac work remains; it must not be reclassified as Mac-only:

1. Integration owner takes this source commit and applies/reviews the pinned main patch,
   verifies current-client/renderer/power lifecycle fencing, and preserves the disabled gate.
2. In an already authorized Windows MSVC/SDK environment, run the local staging helper
   against verified headers/import libraries for x64 and arm64. Load both actual staged
   addons in the exact packaged Electron candidate and test its async safeStorage. This
   desktop has no usable MSVC/SDK or exact installed Electron binary. No install/access
   or CI rerun was requested to bypass that limit.
3. Coordinate exclusive Windows desktop use before a hidden Electron main/worker/renderer
   harness and paired execution measurements. The coordination request remained unanswered;
   no Electron UI was started. Measure total baseline-to-peak allocations, worker/renderer,
   crypto/native buffers and the combined 32 MiB / controlled 8 MiB / 4 ms gates, retaining
   all failures and host scheduling baselines.
4. Supply a second already authorized Windows user session for different-user wrapper
   refusal. Do not create an account, elevate or change permissions. Current-user DPAPI
   alone cannot prove that gate.
5. After the desktop owner authorizes machine interruption, verify physical suspend/resume,
   reboot/expiry and the precise post-native-rename interruption seam. Physical power-loss
   and file/directory durability require their own controlled procedure and remain unrun.
6. Verify the final packaged candidate's traffic/privacy, accessibility and independent
   integrated acceptance. Source spies and synthetic fixtures do not replace that evidence.

Actual Mac hardware alone is required for Darwin builds/packaged loading, native boot UUID
and continuous sleep/reboot clock, Keychain behavior, APFS ACL/ancestry/writer/flush/crash
and exact no-replace/revocation, plus final Mac candidate and physical accessibility/recovery
acceptance. This task neither ran nor claims those gates. No signing, releases, deployment,
merge, new access, account/security changes, secrets or personal content capture occurred.

Reproduce the bounded Node-only checks after compiling the reviewed native sources with
verified local headers/imports, in the isolated worktree:

```powershell
node --import tsx packages/app/test/recovery-preparation/windows-native-probe.ts $existingPrivateParent
node --expose-gc --import tsx packages/app/test/recovery-preparation/windows-native-resource-probe.ts $existingPrivateParent
node --import tsx packages/app/test/recovery-preparation/windows-package-probe.mjs
```

The parent must be an existing safely owned/secured directory; each helper creates its
own uniquely named disposable child. The GNU test build is never substituted for shipping
MSVC/SDK staging or Electron acceptance.
