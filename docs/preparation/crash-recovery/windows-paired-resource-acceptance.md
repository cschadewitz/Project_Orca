# Windows paired resource and packaged follow-up - 9 October 2026

**Acceptance remains incomplete.** The exact #590 candidate
`49a21254dfb02dfce5182902a317298a644bc560` passes the bounded successful
execution equivalence oracle below, but does not establish the Windows 4 ms,
controlled 8 MiB or combined 32 MiB gates. Repeated preview preparation exceeded
4 ms in the measured harness. Its measured memory increment exceeds 32 MiB;
fixture allocation and sampling limits prevent attributing the entire increment
to production diagnostics. No capture requirement or production gate is closed.

This follows [the MSVC/envelope acceptance](windows-msvc-envelope-acceptance.md)
and [ARM64 cross-build evidence](windows-msvc-arm64-crossbuild.md). The retained
task-12 evidence and checkout were read and remain untouched. A fresh isolated
checkout under task-2 used existing dependencies, exact Electron 44.4.5 x64 and
the manifest-verified MSVC native binaries. Native source SHA-256 remains
`3b69d61dc07f1366167f8a151c84925a78d5b70bcc74e7835936c1984a26bdd3`.
Five native manifest inputs were restored to their retained LF bytes because a
Windows CRLF checkout otherwise changes the manifest digest; Git content is unchanged.

The machine initially had 12 logical processors, 34,266,546,176 bytes physical
RAM, approximately 17.5 GB free RAM and 90.8 GB free C: space. A later check
still had approximately 14.76 GB free RAM and 89.9 GB free space. No installer,
dependency installation, OS access change, heavy CI or remote host was used.

## Controlled successful execution pair on exact #590

The isolated pair ran before compiling the consent fix described below. Both
children used the exact candidate's compiled diagnostics and actual Electron
44.4.5 / embedded Node 24.21.0. On used only the explicit test-controller override
and synthetic enum events; shipping `DIAGNOSTICS_PRODUCTION_ENABLED` was verified
false. The private disposable roots were native-created beneath Documents;
the sandbox workspace's inherited ACL was rejected rather than repaired.

A producer collected 8,192 events and settled an encrypted checkpoint using
actual DPAPI JSON envelopes. The supervisor forced only that owned producer
tree to exit and confirmed cessation. On promoted 8,192 prior events, collected
8,192 current events, prepared both reports, rendered the current report through
the actual DiagnosticsSection in a sandboxed fixture renderer, and saved
950,694 exact UTF-8 bytes through separate Choose and Save actions. It then
repeated checkpoint/preview/close 30 times during ordinary execution. Opt-out
settled, leaving only disabled `setting.json` and empty `writer.lock`; the saved
export survived byte-identical. No legacy key API was called.

Each pair member concurrently ran the actual CLI demo program in its own fresh
synthetic store using the scripted ACP provider. Off exited 0 in 44,033.113 ms;
On exited 0 in 44,997.7127 ms. Each produced 29 artifacts and the same completed
work items (`docs`, `login-api`, `schema`). Sorted semantic artifact signatures
were identical:
`ec72d1f4cd300ea6fd291cd29fc79179a48f91522ff16dce73a4dc3a34fea6ba`.

This oracle retains kind, name, semantic front matter, prose and multiplicity,
while excluding generated identity/provenance/timestamp fields and normalizing
generated ID/time text. Raw artifact hashes differ as expected. This proves this
successful program's semantic outputs and terminal work-item states, not all
execution graph edges, arbitrary providers, execution failures or stalled disk
behavior. The broader C15 failure/stall paired oracle remains open. A single
elapsed pair is not a timing-distribution claim.

## Resource measurements and gate decisions

| Measurement | Off | On |
| --- | ---: | ---: |
| Main heap-used + external incremental sampled peak, bytes | 2,178,512 | 59,163,505 |
| Renderer heap + backing + embedder incremental sampled peak, bytes | 0 | 29,795,938 |
| Sum of the two independent managed peaks, bytes | 2,178,512 | 88,959,443 |
| Simultaneously sampled combined private-commit increment, bytes | 1,667,072 | 163,647,488 |
| Conservative sum of OS lifetime peak commit minus baselines, bytes | 3,944,448 | 173,568,000 |
| Private-memory samples | 2,780 | 2,885 |
| Payload reservation counter peak, bytes | 0 | 4,194,304 |
| Native I/O referenced input buffer peak, bytes | 0 | 951,024 |

The main baseline precedes controller/ring construction and promotion. The
renderer baseline follows its actual diagnostics component foundation. Main
values use `process.memoryUsage`; renderer values use CDP `Runtime.getHeapUsage`,
including backing storage and embedder fields. The managed total sums separate
process maxima, rather than claiming they occurred simultaneously.
`GetProcessMemoryInfo` samples only the two owned main/renderer PIDs and reports
private commit plus process-lifetime peak commit. The OS measure includes native,
crypto/libuv and renderer external pages, but private committed pages are not
continuous logical allocation accounting. Requested 2 ms sampling was subject to
Windows scheduling (roughly 15 ms average cadence). Lifetime peaks include
pre-baseline foundation and separate-process peaks need not coincide.

The harness itself retains report oracles, async-hook maps, GC observations and
trace machinery. No forced GC result is treated as an acceptance bound. Thus
these numbers expose a failed measured envelope, but cannot independently prove
the production-only 32 MiB increment. **32 MiB remains open.** The previous
approximately 27 MiB observation is not reused as passing proof.

The reservation and referenced-buffer peaks are not actual controlled allocation
high-water marks. V8 strings/objects, renderer copies, native input snapshots,
DPAPI/crypto and libuv outstanding jobs are not continuously charged to one
audited allocator. **8 MiB remains unproven.** Closing it requires deterministic
allocation accounting/invariants in addition to empirical memory measurements.

Async-hook elapsed maxima during On included capture 2.0418 ms, checkpoint
2.3061 ms, previous preview 3.9485 ms, current renderer-preview main callback
4.2174 ms, Save 2.4588 ms, repeated checkpoint 2.4475 ms and repeated preview
4.8785 ms. A native trusted-clock read took at most 0.4385 ms. These callback
segments are not complete event-loop turns; microtasks can compose a longer turn.
Repeated-preview `setImmediate` heartbeat gaps reached 8.0609 ms, current preview
6.6811 ms and repeated checkpoint 6.0226 ms. Off idle execution reached 5.0625 ms,
so heartbeat delay alone cannot attribute a pause to diagnostics.

Chrome trace retained renderer FunctionCall maximum 2.494 ms, renderer MajorGC
5.075 ms and main MajorGC 3.330 ms. Background GC events are explicitly not
main-thread blocking proof. Instrumentation and Windows scheduler effects remain.
**The full 4 ms gate is not satisfied by this run.** All phase transitions,
oracle phases, GC observations and summarized traces remain in the JSON;
they were not silently removed to improve maxima.

The earlier exploratory pair overlapped package preparation and is separately
labeled exploratory. Startup/argv/monitor-path/poll failures are retained as
failed fixture receipts, with confirmed owned cessation and containment-checked
cleanup. The accepted successful equivalence pair had no packaging/build work
running concurrently.

## Narrow packaged startup consent correction

Actual electron-builder 26.15.3 produced an unsigned Windows x64 directory using
the existing runtime, with rebuild, executable signing and publishing disabled.
No installer was built or run. A second owned image adds only an acceptance
bootstrap and package main selection: it suppresses protocol registration,
hidden-window showing and outside-fixture networking, then loads unchanged product
main/preload/production renderer. A token-authenticated owned loopback daemon
provides a start/end synthetic workflow. This is instrumented packaged execution,
not an untouched installed application or OS packet-capture verdict.

On original `49a2125`, enabled choice persisted in `setting.json` and a separate
native disk read after shutdown retrieved it. On the next cold process, observing
the real disk read returned enabled=true while product status returned Off.
Window navigation/renderer disposal increments the preview epoch while startup's
async setting read is pending. Initialization used that epoch to discard the
durable consent read, leaving the constructor's default Off in memory. It did
not delete the durable setting.

Fix commit `d1e3e7b78d046d334be20365c4ff4e45c33ea152` introduces a separate authority
epoch for reading the startup consent. Preview revocation still increments the
existing epoch and fences preparation, capture initialization, picker and Save.
Off and shutdown increment the authority epoch before any await, so an older
enabled setting read cannot reopen consent. No production flag, IPC, key or
native storage behavior changes. Both navigation and disposal regression cases
fail against the original controller; Off and shutdown regressions pass. All
12 focused startup/report-preparation tests pass with the correction. App build,
root TypeScript no-emit, scoped existing ESLint and Prettier checks also pass.
The lint harness reused existing installed dependencies; no packages were installed.

The fixed candidate was rebuilt by the real builder and the observer around
`readSetting` was removed for the positive packaged run. This candidate preserved
enabled consent across confirmed process exit/restart while production capture
remained false. Cold default Off created no diagnostics root. Explicit enabled
choice created only setting and writer lease; current/previous previews refused
`unavailable` and forged Choose/Save refused `stale_preview`. No legacy key call,
picker invocation or outside connection attempt was observed. Off was awaited
through its IPC response and disk settlement, leaving disabled setting and empty
lease. All owned Electron/daemon exits were confirmed before fixture removal.

Automated WCAG A/AA and WCAG 2.1 AA checks scoped to the actual diagnostics
section found zero violations and zero incomplete checks in each theme (8 passes
per theme). Enter/Home/End/Escape menu interaction restored focus to its trigger;
the trigger had a solid 1.6 px outline. At actual `webContents` zoom factor 2,
the Config body still scrolled to its end in a 680x400 window. Its CSS viewport
was 333 px wide, diagnostics measured 403.9375 px wide, and the Config scroller
had client/scroll widths 436/484 px. Horizontal overflow is observed; 200% reflow
does not pass. This is structural geometry, not proof of visual readability. Narrator, human
readability, preview/unknown-state accessibility, installer identity and an
untouched packaged networking verdict remain untested.

## Retained artifacts and remaining acceptance

The task-2 `evidence/` directory retains the fixture scripts, exact successful
pair, separately labeled exploratory pair, original startup failure, fixed
packaged results, focused test JSON and original/fixed package identities. Copies
of the decisive sanitized JSON are alongside this document under
`native-packaging-evidence/`. No keys, plaintext report bodies, raw boot IDs,
user paths or execution stores are published. Detailed local fixtures retain only
synthetic metadata; private profiles and full report/trace files were removed
after confirmed exits. Retained task-12 binaries/tests are reused with their
existing limits; ARM64 hardware execution was not attempted.

Open: controlled 8 MiB, production-attributed combined 32 MiB and full Windows
4 ms; failure/stall paired execution; real Narrator and human 200%/preview/unknown
accessibility; untouched packaged privacy/network observation; a second already
authenticated Windows user for cross-user denial; physical suspend/hibernate/
reboot and 24-hour expiry; physical power loss or post-rename/pre-result export
interruption; ARM64 hardware execution and independent acceptance review. Those
user/physical scenarios require additional setup and were not improvised.
Signed/downloaded identity, first-run and updater authority remain outside this
diagnostics acceptance scope. No merge, main-target publication or CI dispatch
is authorized by this evidence.
