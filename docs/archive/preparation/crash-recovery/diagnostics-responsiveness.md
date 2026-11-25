# Diagnostics report responsiveness — 9 October 2026

This owned #416/#469 performance slice starts at #574
`455b1e05f3e3a83175678e8a90f181e30244f966`. The
[native packaging acceptance record](native-packaging-acceptance.md) and its
[original measurements](native-packaging-evidence/linux-workload.json) remain unchanged.
Their 38.193 ms preview and 25.650 ms checkpoint delays fail the approved 4 ms gate.
This work reviews only the new diagnostics performance delta, reusing the prior
121-case source/packaging/authority evidence without re-reviewing ancestors.

## Concrete blocker and correction

The pinned Linux native workload reproduced a 32.697 ms preview delay and
18.160 ms checkpoint delay. Profiling and an 8,192-event microprobe identify
whole-report canonical sorting/serialization (9.779–12.875 ms per serialization),
followed by parsing and a second exact reconstruction in the same main turn.
A fixed-key JSON.stringify replacer still took 11.867–12.514 ms.

The ring now freezes its event/coverage/omission scalars atomically, then serializes
the independent snapshot in 128-event batches separated by Node `setImmediate`
turns. A fixed closed-vocabulary formatter writes incrementally into an output
buffer bounded by the existing 1 MiB report ceiling. It avoids both the generic
per-event sort and the final join of tens of thousands of fragments.

Validation parses the bounded envelope and individual bounded events in yielded
batches, then reconstructs and compares the entire canonical text exactly.
Unknown/duplicate fields, secret-bearing metadata, invalid UTF-8, framing changes,
unsupported enums, offsets, counts and coverage remain refused. Immutable decoded
text supplies the accepted output bytes, so mutation of the input Buffer during a
yield cannot substitute unvalidated export bytes. Previous-report IDs still refresh
only after exact validation.

The controller uses these asynchronous report paths. Its existing operation slot,
timeouts, consent/epoch/document/clock fences, preview expiry and Save admission
remain in force. Checkpoint reserves before freezing and rechecks authority after
serialization before disk dispatch. Live preparation/checkpoint reservations remain
held until actual settlement; current preparation releases the frozen JSON string before
yielded validation to preserve its existing four-copy charge. No report/event count, completeness, policy limit,
native/crypto/storage authority or production enable flag changes. Shared main,
preload, bridge, Workspace and renderer files are untouched; the integrator needs
only the owned diagnostics delta, with no entrypoint patch.

## Focused evidence

[All measured runs and method limitations](native-packaging-evidence/linux-responsiveness.json)
include the pinned reproduction, intermediate failures, instrumented runs and all
three final isolated observations. An early isolated pass did not establish completion:
later failures exposed monolithic parsing and final string flattening. These failed
observations are retained, including the run overlapped with statics/tests.

| Observation | Pinned reproduction | Final three isolated runs |
| --- | ---: | ---: |
| Preview event-loop delay | 32.697 ms | 1.726 / 2.364 / 2.608 ms |
| Checkpoint event-loop delay | 18.160 ms | 1.901 / 1.481 / 1.945 ms |
| Maximum observed active-phase delay | 32.697 ms | 1.901 / 2.364 / 2.608 ms |
| Preview elapsed time | 35.067 ms | 29.422 / 31.030 / 28.593 ms |
| Retained/offered events; omissions | 8,192/8,192; zero | 8,192/8,192; zero, every run |
| Complete canonical report | 974,807 bytes | 974,807 bytes, every run |
| Exact Save survives opt-out | pass | pass, every run |
| Sampled managed increment | 19,378,345 bytes | 17,827,892–21,061,340 bytes |
| Sampled RSS increment | 26,939,392 bytes | 22,519,808–26,574,848 bytes |
| Observed payload reservation peak | 3,145,728 bytes | 4,194,304 bytes |

All three final observations meet the unchanged **observed** 4 ms gate. Yielding
keeps other main work eligible while total preparation still takes tens of ms;
no absolute scheduler/native latency guarantee is inferred. The 4 MiB preparation
reservation already existed: yielding makes it visible to the sampler, whereas the
old synchronous preparation hid it between samples. The accounting ceiling remains
8 MiB. Disk bytes observed after operation boundaries remain 976,112; transient
write/replace and simultaneous-generation high-water remain unmeasured.

Node 24.19.0, installed Vitest 5.0.2 and TypeScript 7.0.2; existing binaries only.
The unchanged Linux addon was compiled locally with `/usr/bin/cc`, Node-API 8 and
official Node 24.19.0 headers checked against SHASUMS256.txt (archive SHA-256
`54f14a297d47ea0794fe272363703d9dc419c96ac68f20d890f98b63754a3e4c`). This does
not compile or execute Darwin. No dependency/lockfile installation or host change.

Across focused verification, 50 distinct cases in the focused report/pretrigger/authority files pass with one
worker and no skips, including eight new report/yield regressions. Four selected
existing integration cases pass: maximum-count concurrent pressure, exact no-replace
Save/opt-out, encrypted checkpoint crash recovery, and production default-off.
The other 38 integration cases were deliberately unselected, not rerun. Root no-emit
TypeScript, scoped ESLint/Prettier, app project-reference compilation and whitespace
checks pass. After the final string-lifetime edit, the 26 affected report/authority
cases pass again; unchanged pretrigger and selected integration evidence is reused. No broad suite, coverage run, Actions run, ancestor review or subdelegation.

Self-review checked the closed formatter against the original generic canonical
oracle (all enums, empty and full-count reports, maximum offset and saturated omissions),
the segmented parser's exact rejection, immutable snapshot/input behavior, authority
revocation at actual yielded turns, reservation settlement and checkpoint dispatch.
No storage, encryption, Save publication or consent policy was changed.

## Remaining gates and integrator handoff

Production capture remains disabled. #416/#469 stay open pending independent review,
final integrator composition and the actual native/device acceptance in
[the pinned handoff](native-packaging-acceptance.md#actual-device-acceptance-to-execute-separately).
Linux Node observations do not establish Electron or Mac performance.

- Rebuild the requested Darwin architectures with verified headers; compose the
  explicit native build into the candidate procedure and preserve both packaging hooks.
  Prove actual packaged Electron load and final signed/downloaded identities.
- Measure the unchanged 4 ms, 8 MiB payload and combined main/worker/renderer 32 MiB
  gates with paired real execution, continuous allocation/high-water accounting,
  native clock/storage latency, GC/scheduler pressure and both full generations/export
  temporary. Sampled standalone increments are not a memory bound.
- Execute Mac same-boot/sleep/reboot/expiry, ACL/two-account/ancestry/lease/crash/full-flush,
  Keychain restart/refusal/rotation, exact preview/export/unknown cleanup/revocation,
  network, accessibility and physical acceptance against the exact disabled candidate.
- Windows native storage/DACL/reparse/no-replace and trusted suspend clock remain absent.
  Narrow actual Windows disabled-candidate privacy/refusal and separately authorized
  synthetic DPAPI evidence remain distinct from positive recovery support.
- Connection/resource producer authority remains unknown until its existing owners
  supply reviewed observations. #570/updater/protected execution recovery retain their owners.

This slice performs no merge, activation, signing, deployment, release or native
Mac/Windows operation. Its draft is stacked directly on #574 for the integrator to
compose the owned delta onto the shared application head.
