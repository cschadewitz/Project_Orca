# Native diagnostics packaging and acceptance — 9 October 2026

This bounded #416/#469 slice starts at #567
`9ac19ead4347180e44be6162a41d2d5726b3f929`, retaining merged #470 and the
incorporated #557 `683d5a484ed9553e5a7f3186955e5abba3ae08f7` and #561
`8dcdc0bd9b23c9582374c87b6d0aae40e62ad827`. Their original
[clock/producers](native-foundation.md), [storage evidence](native-storage-slice.md)
and [controller handoff](implementation-handoff.md) remain scoped historical evidence.
The handle-relative storage, encrypted format and controller are reused unchanged.

## Source and packaging boundary

`native-addon.ts` resolves fixed filenames only. In Electron, both loaders use
`process.resourcesPath/native/diagnostics/darwin-<process.arch>/`; absent, invalid,
unsupported or incompatible resources refuse authority without trying a repository,
environment-selected or Node filesystem fallback. Explicit Node source probes retain
the repository build location. Linux and Windows shipping loaders remain unavailable.
Backend capability checks and the clock's permanent uncertainty latch are preserved.

The explicit `build:diagnostics-native` script builds the two existing C addons with
local Node-API 8 headers and `/usr/bin/xcrun clang`, one selected Mac architecture
at a time. It downloads nothing, registers no installation hook and changes no
signing, credentials, ACLs or production-enable flag. It checks thin 64-bit Mach-O
bundle architecture, bounds binary reads, compares native-source digests before/after compilation
and emits a closed manifest with current native-source digest and binary sizes/hashes.
Only that architecture's generated output is replaced after successful verification.

The Mac resource allowlist copies only the two `.node` files and manifest, outside
`app.asar`. Native staging is excluded from the general `dist` asar allowlist. The
real builder's `beforePack` checks staged current-source/architecture/byte identity;
`afterPack` verifies the actually copied resources. Missing sources normally produce
a builder warning; these hooks make missing native diagnostics a Mac packaging failure.
Windows/Linux packaging do not require or copy these resources.

The manifest explicitly describes **before-signing** bytes. Signing can change native
binary bytes: the candidate owner must record final signed binary/container hashes
in detached acceptance evidence. Do not rewrite the manifest inside an already signed
app, or treat unsigned staging hashes as final signed identity. The existing Mac
`identity: null`/`notarize: false` policy is unchanged; no signed candidate was built.

## Local Mac build recipe and integrator handoff

From the exact clean candidate source, with locally available, independently checksum-verified Node headers and the existing
Mac toolchain, the candidate owner runs from the repository root:

```sh
pnpm --filter @orca/app run build:diagnostics-native --arch arm64 --headers /absolute/verified/node-headers
pnpm --filter @orca/app run build:diagnostics-native --arch x64 --headers /absolute/verified/node-headers
```

Build only the architecture requested by an explicit single-architecture candidate;
the existing ordinary Mac defaults request both architectures and need both stages.
Continue the candidate owner's already approved build/package procedure afterward.
The script requires the header tree's `include/node/node_api.h`; header trust is the
caller's prerequisite, not inferred from that filename. Preserve both native hooks
when composing an identity/signing hook. Record the chosen compiler/SDK/OS deployment
target, headers receipt, source SHA, manifest and final candidate hashes.

Pinned shared handoff: [#572 at
`f4ca6540f94ad4a06704b20d0b9c4c4dd2cc9943`](https://github.com/cschadewitz/Project_Orca/blob/f4ca6540f94ad4a06704b20d0b9c4c4dd2cc9943/docs/implementation/shared-app-consolidation.md).
That head retains #567's main/preload/bridge diagnostics wiring. No entrypoint patch
is required: retain `createDiagnosticsInitializer`, its existing startup observer,
frame/document/epoch/consent fences, sleep invalidation and bounded quit cleanup.
This branch is intentionally still based on #567; the parent composes the owned delta
onto #572 without another branch refresh. No main/preload/Workspace or shared UI file
was edited. No production enable option was added to the initializer.

**Packaging prerequisite still to compose:** the current desktop workflow does not
run the native build, and verified headers are not provisioned by this slice. Its Mac
lane will now refuse missing stages rather than produce an image missing its addons.
The candidate/delivery owner must supply the explicit local native build in its pinned
candidate procedure; no Actions dispatch, workflow/security mutation or release was
performed here. This source recipe is not proof that the Darwin branches compile.

## Focused Linux/source evidence

Node 24.19.0, installed Vitest 5.0.2/TypeScript 7.0.2/builder 26.15.3. Available pnpm
11.19.0 tried to bootstrap an install into an unavailable home directory; checks used
existing `node_modules/.bin` binaries afterward. No dependency/lockfile install or
regeneration occurred. Local `.agents`/`.codex` contain no relevant skills.

- 113 tests passed in seven focused files, one worker: resource loading/copying,
  native clock/storage/startup and controller integration/authority. No skips.
- Final packaging recheck includes the existing Mac builder contract tests and a
  runtime filename-inventory refusal; 29 passed in three files. Across the focused
  runs, 121 distinct cases in eight files were exercised, with no skips.
  New packaging tests use synthetic Mach-O headers and the
  actual locked builder's matcher/copy/hooks, not fabricated Mac execution results.
- Root no-emit TypeScript, scoped lint/Prettier and app project-reference compilation
  pass. The compiled Linux loader correctly refuses shipping native authority.
- Existing native storage Node probe passes exact preview-to-Save bytes, writer
  exclusion/release and opaque-handle refusal. Linux addon rebuilt with existing
  node-gyp 12.3.0 and checksum-verified official Node 24.19.0 headers, SHA-256
  `54f14a297d47ea0794fe272363703d9dc419c96ac68f20d890f98b63754a3e4c`.
  This does not compile or execute the Darwin branch.

The new bounded [measurement artifact](native-packaging-evidence/linux-workload.json)
preserves the initial and final runs, commands and interpretation correction. It uses
the actual Linux native POSIX port in one disposable Node process, with synthetic
keys/clock. All 8,192 offered events were retained, with no omissions and 974,807
canonical bytes. Saved bytes match the preview and the user export survives opt-out.

| Final observation | Result | Acceptance implication |
| --- | ---: | --- |
| Maximum record / initial Promise dispatch | 0.812 / 0.243 ms | These two measured call sites meet 4 ms; excludes deferred synchronous callbacks. |
| Idle / checkpoint / preview event-loop delay | 0.258 / 25.650 / 38.193 ms | **Observed responsiveness gate fails.** Main snapshot/validation work remains synchronous; native asynchronous I/O alone does not clear it. |
| Checkpoint / preview elapsed time | 48.972 / 40.722 ms | Bounded local observation only, not a native latency or 5-second tail guarantee. |
| Managed increment / RSS increment | 21,414,300 / 32,313,344 bytes | Sampled standalone increments; cannot satisfy combined 32 MiB main/worker/renderer acceptance. |
| Payload reservation peak | 3,145,728 bytes | Within the unchanged 8 MiB controller accounting bound in this scenario. |
| Owned disk bytes after operation boundaries | 976,112 bytes | Does not measure transient write/replace high-water or full simultaneous previous/current generations. |

The initial concurrent run had 106.738 ms event-loop delay. Its initial `callbackTargetMet`
field considered only record and initial Promise dispatch, so it was insufficient.
The final probe records per-phase delays and explicitly fails the observed gate;
neither result is dropped. No paired actual runtime workload or hard heap bound is
claimed. The profile/exports are synthetic and deleted after the probe. No real
prompt/log/RPC/audit/store/credential content is inspected or retained.

## Actual device acceptance to execute separately

All rows below are **blocked: no Mac or Windows device/candidate is available here**.
Use a fresh consented disposable session and exact source/candidate identities. Do
not turn the shipping flag on to obtain a test result. Positive native fixtures must
be distinct from the still-disabled real app; reviewed production activation and
actual user consent are separate gates. Bind fixture results and app results separately.

| Device work | Precise proof required |
| --- | --- |
| Mac compilation and Electron load | Build each supported target on Mac; load both addons in the actual candidate Electron runtime from fixed external resources. Check architecture, Node-API/capabilities, missing/wrong-target refusal, downloaded DMG/ZIP source identity and final signed native hashes. Linux Node loading is insufficient. |
| Mac clock | Independent app processes share private same-boot identity; real sleep/wake advances continuous elapsed time. Wall jumps do not create age authority. Reboot replaces identity and refuses recovery; expiry at 24 h and uncertainty stay refused. Publish sanitized verdicts only, never raw boot UUID. |
| Mac storage/privacy | Real userData ancestry/ACL, APFS file and directory flush behavior, two-account access, second-process exclusion and supervised kill/restart, symlink/parent/destination swaps, stable lease identity and native no-replace collisions. Refusal must precede plaintext staging for unsupported destinations. Include Keychain unavailable/locked/rotation/restart and no plaintext checkpoint fallback. |
| Mac crash/export/revocation | Execute the existing C03–C10/C12–C13/C19–C26 matrix at native boundaries: complete authenticated same-boot predecessor only; unknown tail honest; clean exit removes current; opt-out invalidates previews; delayed work retains reservations; unknown Save requires cessation and verified private staging cleanup before fresh intent. Preserve possible user exports and exact final LF bytes. |
| Mac resource/network/accessibility | Paired actual execution oracle, continuous callback/main-worker-renderer allocation/high-water accounting, both full generations and export temp, per-read clock/native latency; 4 ms/8 MiB/32 MiB gates. Observe actual packaged process traffic in off/refused/capture/preview/save/failure, plus VoiceOver, keyboard, themes/zoom/scroll and disclosure comprehension. No diagnostic upload is permitted. |
| Narrow Windows privacy/refusal | With the exact disabled Windows candidate, verify unavailable native authority, no capture/checkpoint/export temporary, no diagnostic key request when unavailable, and no diagnostic external traffic in off/refused/enable-attempt/preview-attempt states. Verify the existing separate async safeStorage seam only in an authorized isolated probe with synthetic bytes: DPAPI user binding, restart, unavailable/rotation refusal and no plaintext fallback. This is narrow privacy evidence, not Windows recovery support. |
| Windows positive native gates | There is still no Windows storage/DACL/reparse backend or trusted same-boot/suspend clock. DPAPI does not supply these. Native owner SID/effective inherited DACL, two-account privacy, junction/ancestry swaps, writer exclusion, no-replace publication, crash/restart and sleep/hibernate proof remain source and device blockers. |

Use [the existing test matrix](test-matrix.md) and [native evidence template](../native-mac-testing/evidence-template.md),
recording pass/fail/blocked/not-run per row, actual model/OS/architecture/filesystem,
candidate and source digests, participant consent and bounded numerical/resource evidence.
#390 owns physical acceptance. Remaining connection/resource producer authority stays
unknown until its actual owner supplies reviewed closed observations; this slice adds
no RPC probes or collection. #416/#469 remain open through responsiveness correction,
independent technical/privacy review and the actual packaged/device gates. #570 and
updater recovery belong to their existing owners; diagnostics is no execution repair.
