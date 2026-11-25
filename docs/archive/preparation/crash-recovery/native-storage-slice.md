# Handle-relative storage and disabled composition — 8 October

This follows [the first native foundation](native-foundation.md), PR #557 at
`683d5a484ed9553e5a7f3186955e5abba3ae08f7`. It advances open #416/#469 while
preserving disabled production capture, the reviewed encrypted format, report limits,
consent/preview epochs, exact Save semantics and Config studio mounting.

## Boundary supplied to root

`packages/app/src/main/diagnostics/initialize.ts` exports
`createDiagnosticsInitializer({ root, safeStorage, chooseDestination })` returning
`{ controller, startupObserver, initialize, close }`. There is no production-enable
option. Root supplies the existing app-owned profile root, async safeStorage and
destination picker. Call initialize after app readiness. Reuse the existing
controller subscription/IPC/window/renderer-generation handlers; pass startupObserver
to the existing bundled-daemon owner's optional onStartupDiagnostic callback.
Close awaits controller cleanup and actual disk settlement before closing native
handles. A logical timeout does not release a live writer lease.

This module registers no IPC, window, power-monitor, app lifecycle or timer handlers.
The updater owner/root retain shared `main/index.ts` and preload integration. Neither
shared file, UI, workflow nor package configuration is edited by this slice.

## Storage implementation

- NodeRecoveryDisk now uses an injected filesystem port for every root/file stat,
  enumeration and open. Existing Node operations remain the default for synthetic
  fixtures. Native composition always supplies its own port; unavailable native
  loading has a refusing port, never a Node/path fallback.
- The Node-API storage backend queues filesystem work off the main thread. It opens
  every directory component relative to its predecessor, holds the private root,
  checks owner/mode/identity and rechecks the original pathname against the held root
  before operations. File opens, bounded enumeration, reads, writes, replacement,
  cleanup and publication are relative to held descriptors. Symlinks and unsafe
  regular-file ownership/modes/hard links are refused before content I/O.
- A stable writer.lock inode uses nonblocking flock. It is never retired through
  unlink, PID, timeout or wall time. Mutation requires the held lease; later operations
  verify its directory-entry identity. A newly acquired lease plus settled owned
  file operations is the cooperative-writer cessation evidence. Four open data-file
  handles and one native job per root are bounded; close frees handles immediately,
  without waiting for JavaScript GC. Tagged opaque objects reject foreign handles.
- Caller-owned bounded Buffers are pinned through async completion rather than copied
  into another native payload. Per-root native handle/job metadata has a compile-time
  64 KiB ceiling. Worker stack, allocator and kernel costs remain separate native
  measurement limitations; this is not a new combined-memory acceptance result.
- Destination validation pins one parent identity. A replacement at the same selected
  pathname refuses subsequent validation/publication. Dispatch uses an opened,
  identity-matching parent and the exact staged inode. macOS uses renameatx_np with
  RENAME_EXCL; Linux's explicit fixture uses renameat2 with RENAME_NOREPLACE. Existing
  destinations are never overwritten. Directory-flush uncertainty after a successful
  move is unknown, not permission to retry automatically or delete a user export.
- macOS checks extended ACLs on opened directories/files. This first conservative
  implementation accepts no allow ACE, including a harmless owner-only allow ACE;
  deny-only ACLs can pass. Unknown/invalid/unsupported ACL results refuse. It never
  rewrites an existing ACL or mode. Files use fsync plus F_FULLFSYNC; directory
  mutations use fsync. Availability/durability still need actual supported-device proof.

[Apple's flock documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)
describes cooperative advisory exclusion; it is not protection against arbitrary
same-account/privileged writers that ignore the protocol. Open descriptors prevent a
parent swap from redirecting I/O into an unrelated replacement directory. Rechecks
do not claim immunity to every transient A-to-B-to-A change or hostile same-account
entry replacement between native syscalls. The native privacy gate must assess this
threat boundary explicitly. The ACL iterator follows
[Apple's zero-on-success/EINVAL-at-end API](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_entry.c),
rather than the different Linux iterator convention.

## Evidence and failure history

Node 24.21.0/pnpm 12.4.2 and the original frozen 535-entry supply-chain install are
unchanged. There is no new dependency or lockfile edit. The explicit native build
uses the same checksum-verified official headers and node-gyp 12.3.0 as #557.

- 108 focused tests passed: injected native boundary/disabled initializer, disk,
  storage, authority and controller integration. The expanded three-case native
  boundary/syscall file was rechecked after adding descriptor-budget and process-kill
  cases; it passed. No broad full-suite/coverage duplicate was run.
- The exact production syscall core compiles as a disposable Linux fixture without
  downloading Node headers in tests. It exercises safe create/read/flush/replace,
  same-process and cross-process writer exclusion, release after supervised SIGKILL,
  immediate descriptor-budget recovery, symlink/hard-link refusal, no-clobber Save,
  changed destination-parent/root identities and bounded enumeration.
- The same syscall fixture passed AddressSanitizer and UndefinedBehaviorSanitizer.
- The full Linux Node-API addon rebuilt/loaded. A disposable native-port/controller
  probe passed encrypted checkpointing, exact preview-to-Save bytes, rejection of a
  foreign opaque handle, writer exclusion and reacquisition after close. It uses
  synthetic keys and a synthetic clock; it proves neither Keychain nor native time.
- Repository typecheck, build, lint/CSS, format/design checks and diff checks passed.
  Build retains the existing renderer chunk-size warning.

Development failures remain recorded: initial C build rejected misleading indentation;
the first focused run found the sandbox's system-root UID differed from zero and an
existing unsafe-mode fixture was masked by inherited umask 077. The walker now uses
the owner of the opened system root, and the negative fixture establishes its mode
with chmod on that disposable file. No host umask or permissions were changed.
Adding the process-kill case exposed a test-variable name shadowing write(2), fixed
before the sanitizer ran. Lint rejected console.log in the explicit probe; its only
output now uses stdout for a fixed sanitized verdict. No assertion or native safety
flag was weakened to pass these checks. #470/#557 historical failures remain intact.

## Native test preparation and remaining gates

After the explicit binding.gyp build documented in the first foundation, the reusable
Node-API probe is:

```sh
pnpm exec tsx packages/app/test/recovery-preparation/native-storage-node-probe.ts
# On macOS, use a canonical existing temp parent to avoid /var or /tmp symlink aliases:
pnpm exec tsx packages/app/test/recovery-preparation/native-storage-node-probe.ts /private/tmp
```

It creates/removes only its own disposable profile and publishes a fixed verdict.
It does not activate the production controller or access secure storage. The current
fixed loaders still expect the explicit repository addon build location; packaged
resource placement/Electron load is outstanding and must be composed by the native
candidate owner. This slice does not dispatch a workflow, build a release or change
signing/security permissions.

For the afternoon Mac candidate, root must first compose this initializer, build/load
both addons on the supported architecture and package them at a reviewed fixed
location. Then verify actual userData ancestry/ACL refusal, second-process and
process-kill exclusion, symlink/parent/destination replacement and no-clobber behavior,
APFS/full-flush/crash durability, async Keychain availability/rotation/refusal, boot
identity across restart/reboot and continuous elapsed time across sleep/wake. Include
paired execution callbacks and transient main/worker/renderer managed/external-memory
measurements. The 4 ms target, 8 MiB controlled payload and 32 MiB combined acceptance
are unchanged and unmeasured for this native path.

Windows remains unavailable: there is no Windows filesystem backend, trustworthy
same-boot identity or suspend/hibernate proof here. DPAPI per-user protection,
owner SID/effective inherited DACL, reparse/parent replacement, stable writer exclusion,
no-replace publication and second-account privacy require Windows native evidence.
Do not use wall-derived boot identity, change account/security permissions or claim
that these Linux fixtures establish Windows privacy.

Other connection/resource producers, packaged/physical acceptance and #416/#469 remain
open. Root owns CI admission, independent review and merge. This author stops after
this coherent publication; subsequent work uses a fresh saved-cloud task.
