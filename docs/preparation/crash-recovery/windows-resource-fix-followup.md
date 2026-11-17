# Windows resource fixes and zoom follow-up - 9 October 2026

**Acceptance remains incomplete.** Continuous controlled binary admission now
has a measured 5,406,720-byte high-water mark below 8 MiB. Main preview callbacks
are below 4 ms in the bounded rerun, but measured event-loop gaps still exceed
4 ms. The least intrusive observer measured 59,260,492 bytes of combined
managed/external increment, above 32 MiB. These thresholds are unchanged.
Production capture remains disabled.

The subsequent [heap-churn follow-up](windows-heap-churn-followup.md) records
targeted main allocation fixes and a fresh bounded acceptance. The dated
measurements and original manifests below retain their original pins and limits.

This follows [the original paired acceptance](windows-paired-resource-acceptance.md).
The exact #590 successful CLI pair, native MSVC/DPAPI evidence and ARM64
cross-build remain retained evidence with their original limits. No long CLI
equivalence rerun, broad suite, CI dispatch, remote host, installation, access
change, merge, main publication or first-run/updater authority was added.

## Source changes and accounting

The startup consent fix `d1e3e7b78d046d334be20365c4ff4e45c33ea152` is preserved.
Resource composition at `bede7ffd4b63131de0db748aaba9bb013f90b1be` adds one
shared lazy 5 MiB arena across the controller, compact ring and serialized disk
operations. Arena leases are admitted before allocation, zeroed before reuse,
and released after actual work settlement. Provider output allowances are
admitted before dispatch and remain charged until the serialized operation
settles. The closed Windows JSON-envelope provider gets a conservative 32 KiB
allowance per call, covering its bounded input/output/adapter copies; provider
and OS internals remain separate limitations.

Canonical serialization uses 32-event batches. Validation compares each bounded
canonical event immediately, keeping no second parsed report tree. An atomic
snapshot copies at most 81,920 compact bytes before yielding and serializes one
event at a time. Authenticated seal/open work runs in 64 KiB chunks, reserves
temporary output before each synchronous crypto call and writes into arena-owned
storage. It does not leave a fresh full-size ciphertext/decrypted Buffer waiting
for GC on each repeat. The format, authentication, exact report/event ceilings,
deadlines and retention policy remain unchanged.

The entire renderer text remains in the document, including its final newline.
256-line blocks defer offscreen layout without parsing JSON, clipping report
bytes or caching a second preview. The maximum-text regression verifies all
1,048,576 characters across 128 blocks, then verifies disposal. Native textarea
layout was tested and rejected because it increased memory use; its raw receipts
are preserved locally and are not final-gate evidence.

The allocator counter is continuous admission/ownership accounting, not a heap
sample or a claim of physical GC reclamation. It counts the full arena and
conservative opaque-output allowances. JS strings/objects, retired engine
storage, provider internals and OS allocations belong to the separate measured
gate. Initialization supplies the same owner to disk and controller. Focused
regressions cover maximum all-byte authenticated roundtrip, reuse/erasure,
provider reservation before dispatch and retention of pending Save bytes across
timeout/Off until actual settlement. Logical preview/renderer reservations
remain separate from this binary counter.

## Bounded observer comparison

Four original cells at `1e443400b50614136d94db27723ac0c48f40cf91` separate
instrumentation overhead: Full/Minimal each run Off/On sequentially, minimum
seven seconds per cell, 30 preview repeats for On. Full retains async hooks,
per-callback status sampling, GC/trace recording, spin heartbeat and plaintext
oracles. Minimal has no hooks, heartbeat, trace or retained plaintext oracle;
it samples main every 100 ms and renderer at phase boundaries. The same OS
private-commit monitor is used in both. Full measured 193,696,499 bytes of
combined increment; Minimal measured 175,717,933. Observer overhead did not
explain the failing result.

The final resource rerun uses the same two affected On cells, without concurrent
tests or builds. Each has a fresh native-created private profile, an 8,192-event
producer checkpoint and confirmed forced exit of only that owned producer.
Actual Electron 44.4.5 / embedded Node 24.21.0 uses the existing x64 MSVC binaries
and current-user DPAPI. Each promotes the previous candidate, collects 8,192
current events, performs separate Preview/Choose/Save, repeats checkpoint/
preview/close 30 times and completes opt-out. All owned exits and disposable
profile removal are confirmed. No legacy key API is called.

| Measurement | Full observer | Minimal observer |
| --- | ---: | ---: |
| Duration, ms | 9,206.3917 | 8,150.9697 |
| Main heap-used + external incremental sampled peak, bytes | 38,817,897 | 28,884,357 |
| Renderer heap + backing + embedder incremental sampled peak, bytes | 32,427,570 | 30,376,135 |
| Sum of independent process peaks, bytes | 71,245,467 | 59,260,492 |
| Continuous controlled binary admission high-water, bytes | 5,406,720 | 5,406,720 |
| Controlled bytes owned after opt-out, bytes | 0 | 0 |
| Simultaneous OS private-commit incremental peak, bytes | 157,442,048 | 143,564,800 |
| Saved report bytes | 950,227 | 950,835 |
| Saved events, verified after exit | 8,192 | 8,192 |

Saved report SHA-256 values are
`dc04435fa3659da1acc440ef2108cf6b5f7cc0fc4967ed5f47cc604fa67dcd3a`
and `5597d40db13e1c97fbeba7ed72cebc5eff1ef252b22347584a10e8f39ed47ea2`.
Fresh opaque IDs/clock offsets explain byte/hash variation. Full's live text
oracle checks Save equals the exact displayed text; both supervisor oracles
check 8,192 events and zero budget/expiry/invalid omissions after child exit.
Full also explicitly checks 8,192 previous events. Minimal does not parse the
previous report as an additional measured oracle.

Full main callbacks: previous Preview **3.2317 ms**, current Preview **2.8233 ms**,
repeated Preview **2.8665 ms**, initial checkpoint **1.4544 ms**, repeated
checkpoint **0.4891 ms**, Save **2.5680 ms**. The previous 4.8785 ms repeated
preview callback failure is removed in this rerun. However same-phase heartbeat
gaps reach **4.3406 ms** during current Preview and **4.4377 ms** during repeated
Preview. Maximum observed main GC duration is **2.1532 ms**. The strict 4 ms
event-loop-tail gate remains open. This short rerun is not a new proof under
the retained 44-second paired CLI load.

The 32 MiB gate is **failed**, even with Minimal. Main and renderer peaks are
summed conservatively, not claimed simultaneous. Main `arrayBuffers` is not
added to `external` twice. Renderer component readings and the main-at-peak
reading are preserved. No forced collection, low-memory engine flag, shorter
report cutoff or exclusion of inconvenient engine/native readings was used.
Sampling cannot prove continuous JS/OS bounds; private commit is disclosed
separately from the managed/external calculation. The remaining heap churn
needs further engineering and affected acceptance, without raising the budget.

## Packaged privacy, consent and reflow

The final unsigned x64 directory artifact is built from
`a35691f3b22eb193df1108e3a47e69356e49fce9`. Its instrumented copy changes only `package.json`'s main entry
and adds an acceptance bootstrap. Product main/preload/renderer bytes and
manifest-verified native inventory are checked separately. The bootstrap
suppresses protocol registration, window showing and outside-fixture traffic.
It is a feasible packaged-path check, not an untouched installed-app network
verdict. No installer or first-run/updater operation runs.

Default Off creates no diagnostics root. Explicit enabled consent persists
across restart while production capture stays disabled. Both Preview sources,
forged picker and Save are refused; only `setting.json` and empty writer lease
remain. Off settles to a durable disabled setting. Legacy key calls, picker
calls and blocked outside connection/request attempts are zero. The fixture
daemon has one synthetic successful run and uses only owned authenticated
loopback traffic.

Both light/dark diagnostics-section axe checks have eight passes, zero
violations and zero incomplete checks. Enter/Home/End/Escape menu behavior
restores trigger focus; visible outline is solid, 1.6 CSS px on this host.
The actual 2x zoom check uses a 680x400 native window and a 333x169 CSS viewport.
The shell now has an explicit bounded grid column. Config uses the existing
token-owned narrow-layout threshold to stack fields and reflow complete action
labels/path text. After the responsive state settles, diagnostics width is
245.6000 CSS px, Config client/scroll widths are both **278**, scroll-left is
zero, and the single Config scroll region has 6,307 px content, 32 px client
height and reaches scroll-top 6,275.2002. **No horizontal overflow remains.**
Earlier failed geometry readings and one disposable daemon-start refusal are
retained; the successful retry's checks are not inferred from those failures.

Final original/instrumented ASAR SHA-256 values are
`3d4f9e481334a60e718129c9b291563dbcf7c77aebf88b53aa01bf548aeb250b`
and `87603a4990f18bdaa7d3436f571299d330581070d53bedf5e3a0485e0e6963b2`.
Artifact identities, geometry and checks are in the linked
[manifest](native-packaging-evidence/windows-resource-fix-manifest.json).

## Verification and remaining acceptance

The five focused ownership/report/ring/consent/diagnostics files pass **66/66**
tests. The directly affected diagnostics/legacy Config/Studio Config renderer
files pass **63/63** (overlap is intentional; these totals are not added).
Root and app TypeScript, renderer TypeScript, scoped ESLint/Prettier, changed CSS
token checks and affected renderer/directory package builds pass. No broad suite
or CI was run. Commits use Calcifer Schadewitz `<347762766+calciferschadewitz@users.noreply.github.com>`;
draft #591 targets only #584's integration branch.

Remaining: strict 4 ms tails and a current paired-load responsiveness proof;
32 MiB managed/external peak; C15 failure/stall equivalence; untouched-package
network observation; manual Narrator/large-preview assistive and selection
behavior; a second authenticated Windows user/access test; physical sleep,
reboot/power interruption and 24-hour expiry; post-rename/pre-result boundary;
ARM64 hardware execution; independent technical/privacy review. Second-user
and physical tests require additional setup and were not improvised. Production
capture remains disabled and Windows first-run/updater authority is unchanged.
