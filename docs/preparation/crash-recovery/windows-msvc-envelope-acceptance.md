# Windows MSVC and JSON-envelope acceptance - 9 October 2026

The subsequent [authorized ARM64 cross-build follow-up](windows-msvc-arm64-crossbuild.md)
supersedes this snapshot's missing ARM64 import/build prerequisites. Runtime and
substantial acceptance gaps below remain open. Publication is tracked by the new
draft PR against #584's integration branch; the original evidence bytes remain intact.

This addendum tests combined #584 `6fcd543a368246c2156f86a225072a871c754435`
(tree `347915826aeaeaebb2bec244856b01326137968c`) plus local, unsquashed fix
`8969932b3d7f198046a76f88a9bec509ab7dec00`
(tree `34898285c6e9ba58be287b765aabbd75e1fc229c`). It retains #574 packaging,
#578 responsiveness and the corrected #588 1-2048-byte opaque JSON-envelope
contract in [the integration correction](../../implementation/windows-diagnostic-envelope-composition.md).
The original combined source did not build with MSVC; the positive observations
below apply to the fix commit, not the unmodified combined head. Earlier GNU,
raw-key, initialized-profile and unsuccessful cold-profile evidence remains
unchanged with its original limits. No requirement or production capture gate is closed.

## Installed tools and narrow correction

The read-only check found a complete Visual Studio Build Tools 2022 instance
17.14.37710.0, MSVC 19.44.35229.0 (14.44.35207) with x64/ARM64 compilers and
Windows SDK 10.0.22621.0 with x64/ARM64 libraries and UCRT headers. There was no
running installer; none was launched, changed or dismissed. Initial capacity
was 12 logical processors, approximately 17.7 GiB free memory and 91.56 GiB free
workspace-drive space. Exact Electron 44.4.5 x64 was separately checksum-verified
from its official release and extracted into a new owned runtime copy.

MSVC exposed three actual build failures in order: incompatible inherited
`-std:c++20` and `/std:c11` options (D8016), SDK absence of the WDK-only
`FileRenameInformation` symbol (C2065), and possibly uninitialized `held`
(C4701 with warnings treated as errors). The fix subtracts inherited C++ options,
uses the documented rename information-class ABI value 10, and zero-initializes
the guarded stat structure. Warning level 4, warnings-as-errors, held-handle
checks and no-replace publication remain.

Self-review also found that node-gyp's explicit Windows `--nodedir` contract
links `Release/node.lib`, while the helper only checked `<arch>/node.lib`.
The helper now copies verified headers and the selected architecture's import
library into a private build scratch tree, passes that tree to node-gyp, and
removes it before staging the closed native inventory. Caller headers are not
changed. The package probe now copies all five native manifest inputs, including
`keys-windows.c`. No main/preload/Workspace, protocol, capture gate or installer
wiring changed.

The actual x64 MSVC C11 build passed using Node-API 8, node-gyp 12.4.0,
Python 3.10.6 and verified Node 24.19.0 headers/imports. Source digest and
unsigned binary identities are in
[the build manifest](native-packaging-evidence/windows-msvc-x64-manifest.json).
The five-input source SHA-256 is
`3b69d61dc07f1366167f8a151c84925a78d5b70bcc74e7835936c1984a26bdd3`.
This is distinct from unmodified combined source digest
`41f7daf2e53d6ab8e233469ded0537d21e86485ffd2d5a616dd9351c17606a12`.

## Verified native and exact Electron behavior

[Native evidence](native-packaging-evidence/windows-native-msvc.json) records 11
passing groups against those exact MSVC bytes: kernel-clock continuity between
processes and wall-clock independence; private root and exclusive writer;
non-private inherited DACL refusal without repair; held ancestor-swap refusal;
hardlink preservation/refusal; root and child reparse refusal; closed names,
device names and alternate streams; file/handle/close bounds; exact 1 MiB
no-replace Save and consent/destination leases; forced-exit checkpoint recovery
and opt-out; and interrupted-export writer fencing with key-independent unknown
cleanup. That matrix uses synthetic keys. Its parked export is before native
publication, not a physical power loss or a post-rename/pre-result crash.

[Package evidence](native-packaging-evidence/windows-msvc-package.json) verifies
the actual builder matcher/copy, before/after hooks, current-source manifest,
fixed external load, wrong architecture and missing-resource refusal. That
copy probe is Node-hosted; it makes no Electron runtime claim by itself.

[Exact Electron evidence](native-packaging-evidence/windows-electron-msvc.json)
then loads those MSVC DLLs through the production fixed external-resource loaders
in actual Electron 44.4.5 / embedded Node 24.21.0 x64. This is a disposable runtime
copy with the real builder-copied resources and actual diagnostics component;
it is not a full ORCA installer or app.asar candidate.

- A first producer in a fresh, unprimed synthetic profile creates the real
  NodeRecoveryDisk control/session envelopes (195-231 bytes), uses `ORCADP01`
  wrappers, records 8,192 events and settles its encrypted checkpoint. It calls
  no legacy safeStorage API. The supervisor then forces only that owned process
  tree to exit and observes cessation before a second process starts.
- The second process promotes all 8,192 prior events and collects 8,192 current
  events. Numeric budget/expired/invalid omissions are zero; the report correctly
  retains `unavailable: "unknown"`. The actual production React DiagnosticsSection
  renders the exact current preview through an isolated fixture-only IPC bridge.
  Separate Choose and Save buttons publish 959,527 byte-identical UTF-8 bytes
  through real native storage. After the actual Off action settles, renderer text,
  history, wrappers and staging are removed. The saved export survives unchanged;
  only disabled `setting.json` and an empty `writer.lock` remain in the owned root.
- Actual native protection round-trips 1 and 2,048 plaintext bytes; JS and native
  protection refuse 0 and 2,049. Mutation immediately after dispatch does not
  alter the copied input. Four outstanding jobs complete and a fifth refuses.
  Tampered new-format data refuses with no legacy fallback. A synthetic legacy
  `v10` envelope reads through actual Electron profile authority, after the fresh
  DPAPI interruption proof. Existing provider-rotation unit evidence is reused;
  rotation of a real user's key/profile was not attempted.
- With native resources present, the actual shipping initializer starts disabled,
  creates no diagnostics root on clean default Off, refuses capture and current/
  previous preview, and invokes no legacy key or picker API. Explicitly persisting
  an enabled choice still does not collect production events. Off leaves only the
  disabled setting and empty writer lease. Shipping
  `DIAGNOSTICS_PRODUCTION_ENABLED` remains false. Positive capture above uses only
  the documented test-controller override and synthetic enum-only events.

All owned child exits were confirmed before containment-checked fixture removal.
Normal profiles, Casey's checkout, agent-01, its daemon and the shared desktop UI
were not used. The hidden renderer has sandbox/context isolation, no Node integration,
no external CSP connections and fixture-only methods. No general diagnostics,
packet/log capture, account/OS permission change or real execution store was enabled.

## Responsiveness and resource limits

Main async-hook callback elapsed maxima in this bounded Windows run were:

| Phase | Maximum milliseconds |
| --- | ---: |
| Record call | 0.4302 |
| Capture callback | 2.0255 |
| Checkpoint callback | 1.9791 |
| Previous preview callback | 3.6131 |
| Current renderer-preview main callback | 3.1641 |
| Save callback | 2.6101 |

All phase transitions and oracles remain in the JSON, including 40.9606 ms for
oracle/renderer construction, 5.6586 ms for Save-to-oracle and 6.6067 ms for
Off-to-settlement. One-millisecond timers showed approximately 15 ms idle delay
and similar active-phase delays; renderer foundation reached 43.6612 ms. This
does not establish a complete Windows 4 ms event-loop/renderer/paired-execution
gate. The Linux 1.7-2.6 ms observation is not Windows proof.

The main memory baseline is before controller construction/ring allocation and
prior-session promotion. The renderer baseline is its blank context. Sampled
main heap+external increased 20,639,188 bytes; precise renderer JS heap increased
7,648,133 bytes; their sampled sum is 28,287,321 bytes (27.0 MiB). Main RSS
increased 56,131,584 bytes, including fixture renderer foundation and oracle
overhead. This is neither a native allocation high-water nor a controlled
production increment. Renderer external memory, native/crypto/libuv jobs and
paired execution are missing. Reservation peak was 4,194,304 bytes, not proof of
the complete controlled 8 MiB envelope. **Combined 32 MiB, controlled 8 MiB and
full Windows 4 ms acceptance remain unproven.**

## Focused validation and retained failed observations

The compiler/staging delta passes 22 focused packaging/staging cases in two files,
app project-reference TypeScript, scoped unchanged ESLint/Prettier rules and
whitespace checks. Integration's 88 distinct envelope/configuration/main/CLI
cases are reused at their pinned combined source; broad tests and CI were not rerun.
Reverse application checks the pinned code patch against the committed files.

The local harness had unsuccessful runs before its final pass. Closed receipts
are retained in the handoff directory, not counted as extra successful coverage.
Its mistakes were summing `unavailable: "unknown"`, expecting writer-lease removal,
inspecting transient status before actual IPC action settlement, and letting
Electron's default window-all-closed quit before success-receipt flush. Its first
supervisor also lost the closed consumer failure phase. These were test-harness
corrections; no product/controller/renderer change was made for them. The native
matrix initially used a private outer directory, making its allegedly unsafe
inherited-ACL fixture private. Correct placement under the intended Documents
parent passes; no existing ACL was repaired or modified.

## Exact remaining steps and gap ownership

ARM64 MSVC/SDK is installed, but the verified local ARM64 Node import library is
absent. Supply existing official Node 24.19.0 `win-arm64/node.lib` with SHA-256
`88dea6ff6656445ee22ed8843816d8d90d707c3d05228bd0a3ad56ea30e8a395`, or authorize
that exact Node-source download (earlier download approval covered Microsoft and
Electron). Put it at `<verified-header-root>/arm64/node.lib`, then run:

```powershell
node packages/app/scripts/diagnostics-native-package.js --arch arm64 --headers $orcaVerifiedHeaders
```

Cross-compilation does not establish actual Windows ARM64/Electron runtime behavior.
Use an already authorized Windows ARM64 host for that acceptance; no account or
access provisioning is performed here. Apply the pinned code patch to the combined
candidate before claiming its MSVC build passes. If integration changes any native
input, rebuild stage/manifest and validate that new immutable source selection.

Other **non-Mac gaps**: full packaged ORCA startup/connection/restart/privacy/traffic
and Windows keyboard/accessibility/readability; independent review; paired execution
and complete resource/event-loop gates; second already authorized Windows user
session for user-binding refusal; physical sleep/hibernate/reboot, expiry and
power-loss durability; and post-native-rename/pre-result interruption. Windows
first-run boot/volume/ownership remains deliberately unavailable and is outside
#386's native Mac first-run scope; it does not waive #416's Windows requirements.
Signing/provider/release-policy decisions are separate owner inputs, not Mac-only.

**Actual Mac hardware gaps**: Darwin build and packaged load, Keychain/TCC authority,
boot UUID/continuous-clock suspend/reboot behavior, APFS metadata/ancestry/flush/crash,
native supervisor and physical Mac recovery/accessibility. No Windows or Linux
observation is substituted for those.

The fix is a local Calcifer-authored commit and pinned patch for integration. The
existing draft #585 is unchanged. No fresh publication, signing/release/deploy,
merge, workflow dispatch or rerun occurred.
