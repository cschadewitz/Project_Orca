# Windows diagnostics observations - 9 October 2026

Historical pre-implementation evidence at `6ff89c9`. The substantive Windows follow-up
is documented in [Windows native implementation and acceptance](windows-native-implementation.md).
That follow-up supersedes the source-capability gaps below; these original observations
and unsuccessful measurements remain intact.

This narrow #416/#469 slice tests combined [#584](https://github.com/cschadewitz/Project_Orca/pull/584)
at `a991fbfea9da6d39dea2f0c513cc5a000d993c14`. Its ancestry retains
[#574](https://github.com/cschadewitz/Project_Orca/pull/574) packaging and
[#578](https://github.com/cschadewitz/Project_Orca/pull/578) responsiveness. Reuse their
[native acceptance matrix](native-packaging-acceptance.md) and
[Linux performance evidence](diagnostics-responsiveness.md) with their original limits.
Linux's 1.726-2.608 ms preview observations prove neither Windows latency nor the
combined 32 MiB gate. This work closes no native/product acceptance issue.

## Isolation and actual environment

Windows 10 build 19045, x64, Node 24.19.0. Initial native memory query reported
34,266,546,176 bytes total / 20,372,090,880 available; 12 logical CPUs and
100,764,794,880 bytes free on C:. WMI capacity queries were denied; no permission
change was made. A separate repository clone and Git worktree were created beneath
this task's workspace at the exact combined SHA. Casey's existing checkout was
not changed. Installed dependencies were read through local links, with workspace
package links redirected to this worktree. No install or lockfile change occurred.

Tests use one worker, no shared UI, no daemon and disposable synthetic state. No
agent-01 connection or mutation was made. All DPAPI children were hidden, bounded,
supervised and confirmed exited before deleting their own checked temporary root.
No real prompts, logs, execution stores, credentials, account identifiers, paths,
ciphertext or boot identifiers are included in committed evidence. Shipping capture
remains disabled; the positive controller fixture enables only its memory-only port.

## Verified results and localized correction

- The actual Windows shipping clock returns unavailable. The shipping storage/files
  port refuses; both Windows architectures refuse repository and packaged addon
  locations. No reviewed Windows native backend is present.
- Two actual Windows source initializer lifetimes exercise off, refused enable,
  startup failure, record, current/previous preview, stale picker/save, checkpoint
  and document disposal. No diagnostic directory/file, safeStorage request or picker
  call occurs. Spies on fetch, TCP/TLS, HTTP/HTTPS/HTTP2 and UDP creation observe zero
  calls during those lifetimes. This is bounded source-boundary observation, not
  an OS packet capture or actual packaged-app traffic verdict. Unsupported cleanup
  may remain pending; this does not promise deletion of inaccessible prior history.
- The separate key seam refuses unavailable protection and provider rotation with
  no plaintext fallback. Native CurrentUser DPAPI wraps 32 synthetic bytes, unwraps
  in two new processes, refuses tampered ciphertext/wrong entropy, and unwraps a
  completed wrapper after its producer is forcibly terminated and cessation is
  verified. [Sanitized native results](native-packaging-evidence/windows-dpapi.json)
  do not prove different-user denial, Electron's asynchronous safeStorage, OS/power-loss
  durability, diagnostics recovery or native filesystem authority.
- The existing report tests execute on Windows: immutable full-count snapshots,
  duplicate/extra-field/UTF-8/framing/enum/count rejection, yielded opt-out/document/
  clock-rollback revocation, retained reservations and checkpoint dispatch fencing.
  Existing clock continuity/rollback/changed-boot tests are synthetic Darwin seam
  tests executed by Windows Node; they are not a Windows boot/suspend clock.
- Windows revealed three failing POSIX-only path expectations in the #574 loader
  tests. The fixtures now use host-native absolute paths and `join`/`fileURLToPath`
  expectations. Missing-addon tests now reach a valid host path. The production
  loader, native implementations, consent/controller policy and shared entrypoints
  are unchanged. Corrected 13-case packaging verification passes on Windows.

**77 distinct passing cases across six files.** The 37-case report/pretrigger/refusal
run and 18-case corrected packaging/refusal run overlap five cases. The selected
clock/storage run passes 27; its two POSIX compiler cases are deliberately excluded
by name and are reported as skipped by Vitest. No selected native execution is claimed.
There was an initial sandbox child-spawn failure before any test executed, then an
authorized bounded runner execution. The initial packaging run had three failures;
their portability correction and final pass are both recorded here.

## Resource observations and remaining failure

The probe uses the actual controller/report code with synthetic time and a memory-only
disk/publication port. It holds full current and previous fixture generations and
checks byte-identical memory-port Save, export survival after opt-out, and cleared
fixture history/staging. It performs no native storage, encryption or filesystem I/O.

| Observation | All three initial runs | Final instrumented run |
| --- | --- | --- |
| Offered/retained events | 8,192 / 8,192 each | 8,192 / 8,192 |
| Counted omissions | zero; unavailable remains `unknown` | same |
| Complete canonical bytes | 974,807 each | 974,807 |
| Payload reservation peak | 4,194,304 bytes each | 4,194,304 bytes |
| Sampled managed increment | 22,094,691-23,282,828 bytes | 18,489,989 bytes |
| Sampled RSS increment | 23,420,928-24,272,896 bytes | 23,797,760 bytes |
| Preview timer-delay maximum | 3.315-13.410 ms | 8.057 ms |
| Idle timer-delay maximum | 15.012-15.044 ms | 14.145 ms |
| Instrumented preview callback maximum | not measured | 3.042 ms |
| Windows observed 4 ms acceptance | not established | not established |
| Combined main/worker/renderer 32 MiB gate | not measured | not measured |

Keep [all three initial observations](native-packaging-evidence/windows-controller.json),
the [first instrumented observation](native-packaging-evidence/windows-controller-instrumented.json),
and the [final observation](native-packaging-evidence/windows-controller-final.json).
The first probe stopped before numerical output because its harness omitted the
required `unavailable: "unknown"` field from an assertion; that assertion was corrected.
The first instrumented run attributed the harness's full-report JSON oracle to preview
(5.543 ms). The final harness separates oracle/phase-transition callbacks; the
`oracle->save` callback still records that 5.935 ms harness work explicitly. No failed
or instrumented numerical observation was dropped.

Windows timer cadence and cross-phase sampling complicate delay attribution. No
baseline is subtracted and no timer/security setting is changed. Callback instrumentation
has overhead and counts promise microtasks separately; a single sub-4-ms callback
observation cannot clear the actual packaged responsiveness gate. The old raw
`observed4msGateMet` fields are retained historical probe labels; they are all false
and are not acceptance sign-offs. The final field is named for observed timer scheduling.

The 4 MiB peak stays within the 8 MiB **controller reservation accounting** ceiling
in these scenarios. Sampled heapUsed+external and RSS increments are observations,
not hard allocation bounds; arrayBuffers are not double-counted. No combined renderer/
worker measurement, paired real execution oracle, native per-read clock/crypto/I/O
latency, transient disk high-water, secure storage or actual Save authority is supplied.

## Reproduction and validation

Use the existing installed tool binaries from an isolated worktree. Commands below
do not enable shipping capture or launch the app/daemon. Preserve every measurement.

```powershell
node node_modules/vitest/vitest.mjs run packages/app/test/diagnostics-windows-refusal.test.ts packages/app/test/diagnostics-report-performance.test.ts packages/app/test/pretrigger-buffer.test.ts --maxWorkers 1 --no-cache --configLoader native
node node_modules/vitest/vitest.mjs run packages/app/test/diagnostics-windows-refusal.test.ts packages/app/test/diagnostics-native-package.test.ts --maxWorkers 1 --no-cache --configLoader native
node node_modules/vitest/vitest.mjs run packages/app/test/diagnostics-native-clock.test.ts packages/app/test/diagnostics-native-storage.test.ts --maxWorkers 1 --no-cache --configLoader native --testNamePattern 'private native clock boundary|serializes native work|fixed production loader'
node --expose-gc --import ./node_modules/tsx/dist/loader.mjs packages/app/test/recovery-preparation/windows-controller-probe.ts
pwsh -NoProfile -NonInteractive -File packages/app/test/recovery-preparation/windows-dpapi-probe.ps1
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -b packages/app/tsconfig.json packages/app/tsconfig.preload.json --pretty false
node packages/app/test/recovery-preparation/windows-compiled-refusal.mjs
```

Scoped ESLint/Prettier, root no-emit TypeScript, app project-reference compilation,
compiled Windows initializer refusal, prose/local links and whitespace are final checks.
The [compiled refusal result](native-packaging-evidence/windows-compiled-refusal.json)
retains honest `cleanup_pending` with zero file/key/picker work, rather than claiming
the unavailable native port erased prior history.
Installed Vitest 5.0.2, TypeScript 7.0.2 and ESLint 10.11.0 are used; dependency/tool
versions were not refreshed. Initial no-emit/lint attempts needed missing local
dependency links (app YAML, maintenance MCP dependencies, lint-config dependencies);
the final checks use the isolated workspace packages. No full suite, coverage, manual
Actions run or rerun occurred. Source pins/digests are recorded in
[the provenance record](native-packaging-evidence/windows-provenance.json).

Self-review checked the corrected native-path oracle, every exclusion above, test
authority/refusal, DPAPI output minimization and child/root cleanup, full-count report
and exact bytes, measurement contamination/limitations and shipping-disabled policy.
No shared main/preload/Workspace/renderer wiring needs a patch for this slice.

## Exact remaining gaps and user/device steps

**Non-Mac gaps remain:** implement/review the Windows trusted boot/suspend clock and
handle-relative owner-SID/effective-DACL/reparse/ancestry/writer/no-replace backend;
complete producer provenance; establish actual 4 ms, 8 MiB and combined 32 MiB/resource/
paired-execution gates; independently review the composed source. These are not
converted into Mac-only blockers by a Windows refusal or DPAPI pass.

For packaged Windows acceptance, provide an exact candidate built from the reviewed
combined source with its digest/runtime identity and a disposable userData directory.
Coordinate a desktop test slot before any shared UI work. Exercise disabled off/refused
states under a scoped process traffic observer, verify no key/file work, then separately
exercise the authorized synthetic async safeStorage seam. No candidate or Electron
binary is installed in this test environment, so these steps were not run. Different-user
DPAPI/DACL proof needs an already-authorized second account and explicit scoped test
session; this work creates no account or new access. Source tests do not replace keyboard/
screen-reader/disclosure comprehension checks against that actual candidate.

**Mac hardware execution remains:** Darwin builds and packaged Electron addon load;
continuous same-boot/sleep/reboot/expiry clock; Keychain unavailable/locked/rotation/
restart; actual APFS ACL/two-account/parent-swap/lease/full-flush/crash/no-replace/export/
revocation; signed/downloaded candidate identity and physical accessibility/recovery
acceptance. Existing candidate/signing/owner decisions and #390's physical coverage
remain with their owners. No signing, release, deployment, merge, security change,
activation or real-user diagnostic capture occurred.
