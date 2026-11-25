# Windows diagnostics heap churn follow-up - 9 October 2026

**Acceptance remains incomplete.** The focused implementation at
`e5d6a0a0ae9e14826c531cf1d94e2d2d16aa00ce` reduces the comparable Minimal
main-process increment from 28,884,357 to **13,762,756 bytes**. Combined
managed/external increment is **45,129,835 bytes**, above the unchanged
33,554,432-byte (32 MiB) gate. Active preview event-loop gaps still reach
**4.2702 ms**, above the strict 4 ms gate. Production capture remains disabled.

The isolated checkout starts at exact #591
`5eece6c7f863e7fe833188843355e107fa2ab3a6`, preserving all ancestry. The
[previous resource and reflow evidence](windows-resource-fix-followup.md), its
manifest and local task-2 checkout are retained unchanged. This follow-up adds
one comparable affected Full/Minimal acceptance and separate bounded profiling;
it does not rerun the old 44-second CLI pair or establish current paired-load
responsiveness. That successful pair remains pinned to #590
`49a21254dfb02dfce5182902a317298a644bc560` with its original scope.

## Allocation finding and focused implementation

The original bounded scenario, with 30 checkpoint/preview/close repeats and
8,192 events, was profiled separately using Node inspector and renderer CDP heap
sampling at 32,768-byte intervals. Including allocations later collected by
minor/major GC estimates **447,680,208 cumulative main allocation bytes**.
Largest sampled main stacks were event validation (82,000,784), report
serialization (71,975,932), serializer Buffer-to-string conversion (57,037,436),
per-batch scheduling (46,160,552), final preview Buffer-to-string conversion
(30,419,916), event cursor construction (29,484,084), crypto string decoding
(28,885,304) and validation UTF-8 decoding (28,518,720). These are sampled
cumulative allocations, not simultaneous retained memory or continuous bounds.

Renderer cumulative sampling estimates 36,027,072 bytes, including
**29,764,824 at the V8 API boundary**, approximately 31 report-sized strings.
React fiber/element work is much smaller. This identifies repeated full-text
crossing as the next allocation target; it does not prove a contextBridge leak
or assign every byte to one native API.

The focused changes:

- Schedule yielded batches with one completion promise and one reused callback,
  preserving the initial yield and every 32-event scheduling boundary.
- Scan each bounded event against the exact closed canonical prefix, decimal
  offset and suffix. Parse/reconstruct the small envelope as before. Unknown or
  duplicate fields, wrong phase/code pairs, noncanonical numbers, framing,
  invalid UTF-8, counts, ordering and coverage remain refused. No event tree or
  rebuilt per-event string is retained.
- Validate immutable current snapshot text directly and reuse the accepted text
  for Preview, removing encode/decode/encode and final decode round trips.
  Authenticated previous bytes still undergo strict UTF-8 validation and refresh
  both IDs only after validation. Save retains independently owned exact bytes.
- Reuse one event cursor over atomically frozen compact scalars and write fixed
  framing pieces directly into the existing arena.
- Serialize checkpoints directly into an arena lease. Authority is checked
  after serialization, and the lease is released and zeroed after actual disk
  settlement or refusal. No full-size checkpoint heap string is needed.

The report format, complete 1 MiB and 8,192-event ceilings, 512-byte event cap,
logical reservations, preparation/preview deadlines, consent, revocation,
ownership, cryptography, key routing, native storage and erasure rules are
preserved. No bridge/preload/renderer or native product source was changed.

A separate post-fix retained-only sampling cell reports 630,696 sampled main
bytes and 3,144,820 renderer bytes at the end; 2,852,304 renderer bytes are at
the V8 API boundary. This is a different sampling mode and is **not** a
before/after cumulative-allocation comparison. Sampled survivors and process
heap usage differ; neither establishes strong retainers or a leak. In the
comparable Minimal acceptance, renderer usedSize remains 32,773,204 at opt-out
despite the preview being removed. Retired engine storage and natural collection
timing remain part of the measured gate. No forced GC, heap snapshot, heap-sizing
or collection flag, or excluded native/backing/embedder reading was used. The
fixture's retained precise-memory reporting switch is unchanged.

## Comparable affected acceptance

Actual Electron **44.4.5**, embedded Node **24.21.0**, Windows x64, current-user
DPAPI, and existing MSVC clock/storage binaries were reused. The native package
manifest is verified against this checkout and the retained x64 manifest:
source SHA-256 `3b69d61dc07f1366167f8a151c84925a78d5b70bcc74e7835936c1984a26bdd3`.
The copied baseline compiled diagnostics also match the original resource-fix
manifest. No installation or native rebuild was needed.

The same owned hidden-window fixture, native-created private disposable profiles,
forced cessation of only the owned checkpoint producer, authenticated prior
promotion, 8,192 current events, separate Preview/Choose/Save, 30 repeats and
opt-out were used. No tests or builds overlapped the run. Full retains the
original hooks, status sampling, heartbeat, trace and plaintext oracles; Minimal
uses 100 ms main and phase-boundary renderer sampling with no retained plaintext
oracle. The OS private-commit monitor is unchanged. Profiling was disabled for
both acceptance cells. All owned exits and disposable profile removal succeeded.

| Measurement | Full | Minimal |
| --- | ---: | ---: |
| Duration, ms | 9,656.9734 | 8,172.7599 |
| Main heap-used + external incremental sampled peak, bytes | 22,388,466 | 13,762,756 |
| Renderer heap + backing + embedder incremental sampled peak, bytes | 31,446,977 | 31,367,079 |
| Sum of independent managed/external process peaks, bytes | 53,835,443 | 45,129,835 |
| Continuous controlled binary admission high-water, bytes | 5,406,720 | 5,406,720 |
| Controlled bytes owned after opt-out, bytes | 0 | 0 |
| Simultaneous OS private-commit incremental peak, bytes | 133,865,472 | 120,381,440 |
| Saved report bytes | 950,577 | 950,506 |
| Saved events verified after exit | 8,192 | 8,192 |

Full verifies previous/current counts, zero omissions and Save equal to the exact
displayed text, including its final newline. Both post-exit supervisor oracles
verify 8,192 events and zero budget/expiry/invalid omissions. Minimal's
`saveExact: false` means that live text oracle was intentionally absent, not a
failed byte comparison. Saved SHA-256 values are
`79064fa8c9acc459be7eb16e5173c213dedfcb36646b19877124ece1d8d6c9c4`
and `2aae09ef47c4ecca90d55c7b65f8b35f6a8750cb53b4a2f535e98b37f065c82a`.
Fresh IDs/clock offsets explain byte/hash differences.

Full main callbacks: previous Preview **2.9586 ms**, current Preview
**2.5060 ms**, repeated Preview **2.4212 ms**, initial checkpoint **1.4797 ms**,
repeated checkpoint **0.3078 ms**, Save **2.6603 ms**. Same-phase gaps reach
**4.2423 ms** during current Preview and **4.2702 ms** during repeated Preview.
Maximum observed main GC duration is **1.1263 ms**. All transitions and setup
measurements remain in the receipt, including **7.3908 ms** across previous
Preview/oracle/current Preview, **4.8696 ms** across Save-oracle/close, and a
**6.8767 ms** setup gap. Those instrumented intervals are not attributed solely
to production diagnostics. The strict tail gate still fails.

Process maxima are summed conservatively, not claimed simultaneous. Main
arrayBuffers is not added to external twice; renderer backing and embedder
readings and main-at-peak are retained. Sampling does not establish a continuous
JS or OS bound. Logical controlled admission is a separate ownership proof and
does not claim physical collection of retired engine storage. The full trace
and plaintext exports were removed with the disposable profiles; sanitized
measurements and local profiling fixtures remain retained.

## Architecture choices before broader work

At this observed renderer peak, 32 MiB leaves only **2,187,353 bytes** for main,
less than its existing 5 MiB arena. More main-only tuning cannot close this
result with the current full-string renderer behavior. The measured overage is
**11,575,403 bytes**. The next scope needs an explicit choice:

1. **Incremental exact-text transport with stable block reuse.** Transfer the
   complete first report and only changed canonical blocks on later previews.
   Bind each block set to a fresh preview handle; assemble every byte in order
   and compare the exact Save oracle. This targets repeated full-report API
   allocation while preserving the existing complete in-document view. It needs
   new IPC/main/preload/renderer authority and invalidation regressions, bounded
   cache admission and disposal across Close, Off, expiry and navigation. Changing
   event bodies must receive complete fallback blocks; savings cannot be assumed
   from this unchanged-ring fixture alone.
2. **A byte-backed preview lifecycle across main/preload/renderer.** Admit and
   reuse a bounded UTF-8 owner, exposing exact blocks for the complete view while
   removing the repeated whole-string result contract. This gives explicit byte
   ownership/disposal but requires a broader bridge and renderer contract, exact
   rendering/selection/accessibility checks and measured accounting of every
   transport/decoder/native copy. It does not assume zero-copy IPC or exclude
   those copies from either resource gate.

Neither option was implemented in this focused slice, and neither is a promised
passing result. Neither changes report completeness, gate thresholds, privacy,
cryptography or the disabled production flag. Scope expansion and another
affected acceptance should follow the product/architecture decision.

## Verification, retained receipts and remaining gates

The five focused report/ownership/ring/startup-consent/diagnostics renderer files
pass **70/70**, no skips. Four new cases cover all closed pairs at decimal
boundaries/noncanonical mutations, immutable accepted text with owned erasure,
scheduling/failure propagation, and a full-count owned checkpoint surviving ring
disposal. Root and renderer TypeScript, affected app compilation, scoped ESLint,
Prettier and whitespace checks pass. One early declaration-order TypeScript
error and a rejection-type lint error were corrected before the pinned build.
No broad suite, coverage or CI was run or dispatched.

The [manifest](native-packaging-evidence/windows-heap-churn-manifest.json) pins
compiled diagnostics, reused native inventory and hashes of the
[acceptance](native-packaging-evidence/windows-heap-churn-results.json),
[profile summaries](native-packaging-evidence/windows-heap-churn-profile.json),
[focused cases](native-packaging-evidence/windows-heap-churn-tests.json) and
[scoped checks](native-packaging-evidence/windows-heap-churn-verification.json).
Raw fixtures/profiles remain under the isolated task-4 evidence directory; prior
task-2 evidence remains untouched. No keys, plaintext report bodies, private
profile paths or execution stores are published.

This draft targets only #584's integration branch. Author and committer are
Calcifer Schadewitz `<347762766+calciferschadewitz@users.noreply.github.com>`. No merge, main publication,
remote host, access change, installation, destructive/physical test or desktop
interaction occurred. Existing consent/privacy and 200% reflow evidence is reused
at its original pins, without a fresh package claim.

Remaining: combined 32 MiB and strict 4 ms gates, current paired-load proof and
the prior failure/stall, untouched-package network, independent review,
Narrator/selection, second-user, physical/24-hour expiry, post-rename/pre-result
and ARM64 hardware gates in the previous follow-up. Windows first-run/updater
authority is unchanged. Capture remains disabled.
