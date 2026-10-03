# Disabled diagnostics buffer: synthetic five-minute benchmark

Evidence for [#416](https://github.com/cschadewitz/Project_Orca/issues/416), against
[PR #441](https://github.com/cschadewitz/Project_Orca/pull/441) head
`97097ea076044555b401d49b8e75da8cc1e42df9`, verified on 2026-10-03.
Harness commit: `9d8499f3b3a91692e14e9a5038975de01f8c9f4d`.
The [harness](../../tools/benchmarks/diagnostics-buffer.js) imports the compiled,
unchanged buffer, profile and snapshot modules only. The
[raw measurements](diagnostics-buffer-results.json) include source, compiled-module
and harness SHA-256 hashes, every trial and memory checkpoint. No application,
workflow, identity, consent or retention policy change is included.

## Scope and method

These are **measured CPU/memory/serialization results over synthetic five-minute
logical histories**, not observed application event rates or five minutes of elapsed
wall time. The injected monotonic clock advances through `(0, 300000]` ms without
sleeping. Only disposable benchmark buffer instances call the same `start()` seam as
the existing unit tests; production capture remains disabled with no live producer.
No private session data, daemon, renderer, logger, network or diagnostics upload is
involved. Only aggregate benchmark metrics are committed. Synthetic export files are
created with mode 0600 in a temporary directory and removed in `finally`.

| Workload | Synthetic schedule | Events offered |
| --- | --- | ---: |
| Low | One event every 10 seconds | 30 |
| Typical | One event per second | 300 |
| High | Ten events per second | 3,000 |
| Bursty | 100/s for the first 10 seconds of each minute, then 1/s for 50 seconds, repeated five times | 5,250 |

“Typical” and “high” are workload labels, not claims about actual ORCA usage.
Every schedule runs with a six-event mix (lifecycle/start, connection/lost,
admission/uncertain, resume/failed, protected-state/unavailable, run/failed) and
with the largest accepted phase/code pair on every event:
`protected_state / protected_state_unavailable`. The harness enumerates the actual
vocabulary to select this pair. Its conservative reservation is 151 bytes/event,
including maximum offset width and canonical framing; the envelope reserves 1,115
bytes. The 512-byte per-event ceiling is unreachable through the current enum-only
API. Unknown metadata remains unknown; no fabricated versions enter the buffer.

There are three fresh Node child processes per schedule/payload pair, launched
**serially**. Each performs two full discarded warm-up passes, then one measured
pass. Each measured pass times every `record()` call, six complete `snapshot()`
calls, one `JSON.parse` preview surrogate, UTF-8 encoding, and a local temporary-file
write + `fsync` + close. The write is read back and compared byte for byte outside
the timing. One frozen snapshot, one parsed object and one UTF-8 buffer are held
simultaneously for memory measurement. Earlier repeated snapshots are released.
The low-volume warm-up is only 60 records: JIT stabilization is not established.

Latency uses `performance.now()` around the operation; assertions, fixture selection,
pressure checks and memory sampling are outside each record timing. Quantiles are
nearest rank, calculated separately per trial; they are not pooled estimates.
The harness also measures a warmed disabled-call path and back-to-back timer reads.
No timer-overhead subtraction or outlier removal is applied.

Memory starts after fixture/timing-array allocation and a forced GC, before buffer
construction. Recording checkpoints are taken every 30 logical seconds, with
additional peak samples every 128 events and after snapshot/preview/export operations.
Post-recording, held-copy, stop and released-copy readings follow forced GC. Thus
recording heap growth includes the ring, retained events and small instrumentation
objects; it is not an exact object-size census. RSS/high-water readings include Node,
module loading and warm-up. Sampled peaks are **lower bounds** on transient peaks;
there is no heap dump or allocation profiler. Full raw heap/RSS/external/ArrayBuffer
readings are retained in the metrics file.

Fixed safety bounds: at most 5,250 offered events per main pass, one child at a time,
256 MiB V8 old-space limit, 120-second timeout per child. The harness stops the entire
suite on any child error or if sampled RSS reaches 384 MiB, used heap reaches 192 MiB,
host available memory falls to 512 MiB, or a visible cgroup-v2 ancestor has 256 MiB
or less remaining. It checks pressure before/after large operations and at most 128
records apart during main-workload recording. This is sampled protection, not an OS memory reservation;
the old-space limit does not cap all native memory. No automatic retry expands bounds.

## Reproduction

Use Node 24.21.0 and pnpm 12.4.2 (the repository pins pnpm). The Python checker needs
Python 3 and `jsonschema==4.19.2`; its requirements file is already in the repository.
If necessary, install those requirements into a disposable virtual environment and
put its `python3` on PATH. From this branch's root:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm exec tsc -b tsconfig.build.json --force
node --expose-gc --max-old-space-size=256 tools/benchmarks/diagnostics-buffer.js > /tmp/diagnostics-buffer-results.json
```

Compile immediately before measuring: the harness checks the source against the
pinned PR head and records compiled hashes, but does not infer whether a pre-existing
`dist` tree is fresh. A changed implementation is refused until the baseline is
reviewed and deliberately updated. Run no other checks or workloads concurrently.
Only consume the JSON if the command exits zero; output is written after all 24
trials succeed. Check progress on stderr. Temporary files are removed on normal/error
unwinding; an external SIGKILL/timeout can leave a synthetic-only temporary directory.

```sh
pnpm exec vitest run packages/app/test/pretrigger-buffer.test.ts --maxWorkers=1
python3 -m unittest discover -s docs/preparation/manual-diagnostics-contract -p 'test_*.py' -v
pnpm run typecheck
pnpm run lint
pnpm run format:check
git diff --check
```

## Environment and measured results

Final run began `2026-10-03T21:47:07.745Z`. Debian GNU/Linux 13.7, kernel
`6.12.107+deb13-cloud-amd64`, x64; AMD Ryzen 7 5700U, eight visible
logical CPUs; 15.62 GiB RAM. Host available memory at start:
3.81 GiB. No finite cgroup-v2 memory ceiling was visible.
Node `v24.21.0`, V8 `13.6.233.17-node.53`, pnpm `12.4.2`,
TypeScript `7.0.2`, Python 3.13.5, jsonschema `4.19.2`.
The only compiler pass needed for the harness was `tsc -b`; Electron was not launched.
All 24 trials completed without a memory-pressure stop.

### Retention and size

Values were identical across the three trials. All end-of-window invalid/expired counts
were zero; missing producer evidence remained unknown. Sizes are complete canonical UTF-8
bytes, including the envelope and trailing newline.

| Workload | Payload | Retained | Budget omissions | Oldest-event age (s) | Snapshot/export bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| low | mixed | 30 | 0 | 290.00 | 5,008 |
| low | maximum | 30 | 0 | 290.00 | 5,533 |
| typical | mixed | 300 | 0 | 299.00 | 40,414 |
| typical | maximum | 300 | 0 | 299.00 | 45,664 |
| high | mixed | 3,000 | 0 | 299.90 | 394,465 |
| high | maximum | 3,000 | 0 | 299.90 | 446,965 |
| bursty | mixed | 4,096 | 1,154 | 238.95 | 538,777 |
| bursty | maximum | 4,096 | 1,154 | 238.95 | 610,453 |

Only bursty reports set `capacityLimited=true`. The burst drops the oldest 1,154
events; the first retained timestamp is 61,050 ms and the last is 300,000 ms.
Assertions compare the full retained timestamp sequence with the expected newest
4,096 events. No hidden snapshot/export truncation occurred.

### Recording and eviction latency

Ranges below are the smallest and largest **per-trial** quantiles, in microseconds;
“worst call” is the maximum across all three trials. The raw file also contains means
and p95 values. With only 30 calls per low trial, its p99 is its maximum.

| Workload | Payload | p50 µs range | p99 µs range | Worst call µs |
| --- | --- | ---: | ---: | ---: |
| low | mixed | 9.928–12.815 | 134.425–143.513 | 143.513 |
| low | maximum | 10.019–12.594 | 142.770–196.333 | 196.333 |
| typical | mixed | 5.531–7.965 | 45.877–116.331 | 1859.624 |
| typical | maximum | 5.410–7.896 | 42.350–115.980 | 4911.713 |
| high | mixed | 3.937–5.620 | 24.055–40.557 | 221.891 |
| high | maximum | 6.092–7.053 | 38.584–47.471 | 699.488 |
| bursty | mixed | 4.238–5.881 | 42.340–60.955 | 898.728 |
| bursty | maximum | 4.008–5.370 | 28.905–49.384 | 15748.693 |

The warmed disabled-path p50 ranged 0.251–0.391 µs;
back-to-back timer-read p50 ranged 0.140–0.210 µs.
These establish instrumentation scale, not a zero-cost disabled-path guarantee.

For bursty/mixed, p50 before count saturation was 4.309–5.891 µs,
and after saturation 4.168–5.862 µs.
For bursty/maximum, p50 before count saturation was 3.897–5.440 µs,
and after saturation 4.489–5.440 µs.

The independent byte-pressure probe lowers the complete-report limit to
16,215 bytes, enough for exactly 100 maximum-reservation events while
leaving the count cap at 4,096. All three runs offered 1,000, retained 100 and reported
900 budget omissions. Record p50 ranged 5.491–7.935 µs. This proves the
byte eviction path at a deliberately smaller test limit; the default 1 MiB limit
was not reached by any current-vocabulary workload.

At logical 600,000 ms, one timed record expires all previous retained events and
adds one new event. Every trial reports exactly the prior retained count as expired,
retains just that new event and clears `capacityLimited`; cumulative budget omissions
remain. Measured expiry-plus-record time ranged
0.083–6.410 ms (maximum across the 4,096-event cases included).
Frozen preview bytes remain unchanged after expiry and stop.

### Snapshot, preview and local export

All times below are milliseconds. Snapshot is the range of each trial’s median of six
calls, followed by the worst single call. Parse, encode and local-write columns are
ranges over the three measured operations. All operations process the complete size
shown in the retention table.

| Workload | Payload | Snapshot p50 range | Worst snapshot | Parse range | UTF-8 encode range | tmpfs write/fsync range |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| low | mixed | 0.252–0.375 | 0.541 | 0.113–0.161 | 0.082–0.144 | 0.155–0.259 |
| low | maximum | 0.267–0.320 | 0.571 | 0.136–0.152 | 0.091–0.253 | 0.142–0.218 |
| typical | mixed | 1.613–2.149 | 3.008 | 0.328–0.463 | 0.080–0.107 | 0.170–0.389 |
| typical | maximum | 1.530–1.868 | 6.172 | 0.321–0.405 | 0.080–0.127 | 0.157–0.237 |
| high | mixed | 11.722–16.255 | 25.104 | 3.249–6.737 | 0.250–0.606 | 0.497–0.791 |
| high | maximum | 14.647–16.118 | 18.602 | 3.352–3.835 | 0.329–0.378 | 0.491–0.947 |
| bursty | mixed | 18.868–23.435 | 33.533 | 3.976–4.589 | 0.358–0.414 | 0.781–0.930 |
| bursty | maximum | 22.671–111.164 | 217.017 | 4.693–11.159 | 0.444–0.940 | 1.013–12.216 |

The bursty/maximum third trial had a 111.164 ms snapshot median and a 217.017 ms
maximum, versus 22.671–24.489 ms medians in the first two trials. Its worst record
was 15.749 ms. These observations are retained, not filtered or replaced by a cleaner
run. This shared-host variation prevents claiming a tight tail-latency bound; there
is no evidence here assigning those outliers to the buffer, GC or another process.

### Memory growth

Ranges across three trials. “Ring Δ” is post-GC heap after recording minus baseline.
“Held copies Δ” is post-GC heap with snapshot + parsed preview + UTF-8 export minus
the ring reading. UTF-8 export bytes also live outside the JS heap. “Sampled heap Δ”
is the largest sampled heap minus baseline, including preparation; it is not the
true allocation peak. RSS is the process high-water mark including warm-up.

| Workload | Payload | Ring Δ KiB | Held copies Δ KiB | Sampled heap Δ MiB | Max RSS MiB range |
| --- | --- | ---: | ---: | ---: | ---: |
| low | mixed | 41.1–41.4 | 27.8–27.8 | 0.56–0.56 | 61.4–62.2 |
| low | maximum | 41.2–41.4 | 29.9–29.9 | 0.57–0.57 | 61.4–62.1 |
| typical | mixed | 56.7–56.8 | 121.0–121.2 | 1.79–1.79 | 63.3–63.7 |
| typical | maximum | 56.3–56.7 | 141.1–141.2 | 1.86–1.86 | 63.3–63.7 |
| high | mixed | 221.5–230.8 | 1101.6–1102.1 | 8.69–8.75 | 82.4–82.4 |
| high | maximum | 189.9–225.6 | 1301.9–1302.1 | 8.95–9.02 | 82.9–84.3 |
| bursty | mixed | 265.0–265.2 | 1516.8–1517.0 | 19.77–19.78 | 92.3–93.4 |
| bursty | maximum | 264.0–284.4 | 1790.0–1791.1 | 18.15–18.17 | 97.7–98.8 |

Thirty-second recording checkpoints in the raw file show allocation/GC variation;
they are not a monotonic leak trace. Repeated discarded snapshots contribute
uncollected garbage to the sampled high-water readings; those readings do not mean
six live previews were retained. Post-stop measurements deliberately still hold
the caller copies; `afterRelease` is a further GC sample after the pass returns and
releases them. No long-session leak conclusion follows from those short observations.

### Representative maximum-size metadata fixture

Separately generated, without passing it to `record()`: 4,096 largest legal enum
events at six-digit offsets; all 64 entity aliases with the longest kind; 17-character
maximum-pattern app/daemon/OS versions; a 40-character synthetic build revision; both
protocol pairs at 65,535; the longest store-format value and saturated omission
strings. Longer unknowns are preserved where a known enum would shorten the report.
Synthetic handshake/admission evidence makes the populated fields semantically valid.
This is a representative maximal-field report, not a claim that producers exist or a
formal exhaustive maximum over every allowed schema combination. The existing Python
checker validates every generated copy, including canonical bytes.

There are three discarded serializer warm-ups and five measurements in each of
three workers (15 measured copies). Every copy is **615,488 bytes**. Measured serializer
median: 29.240 ms; range: 17.905–150.255 ms. Parse range:
3.761–33.294 ms; encode range: 0.402–8.767 ms; tmpfs write/fsync range:
0.705–1.739 ms. Each iteration records pre-serialization,
post-serialization and held-copy memory in the raw metrics.

## Interpretation and recommendations

- The count ceiling, rather than the 1 MiB serialization ceiling, loses history in
  this burst schedule. Keep the requested duration, actual oldest-event age and
  budget omissions visible together; “five-minute buffer” alone would overstate the
  retained evidence. Sparse low-rate coverage also does not imply capacity loss.
- **Arithmetic, not another measurement:** 4,096 / 300 = 13.65 events/s is the
  approximate sustained five-minute count allowance. Retaining this particular burst
  schedule in full would require 5,250 slots; with the largest current reservation,
  1,115 + 5,250 × 151 = 793,865 reserved bytes would fit below 1 MiB. That does not
  authorize a larger count/schema cap or establish heap/latency at that cap.
- Treat complete canonical bytes and process memory as separate budgets. A frozen
  JSON string, parsed preview and UTF-8 export have distinct allocations. The buffer's
  `stop()` cannot reclaim copies held by its caller. A future preview owner needs
  bounded copies and a separately reviewed lifetime/revocation design.
- Snapshot preparation is synchronous. The measured runtime leaves room relative
  to the proposed two-second preparation deadline on this host, but does not establish
  that deadline under execution load or on native targets. Measure event-loop blocking,
  timer-driven idle expiry, IPC transfer and actual preview rendering on packaged
  Mac/Windows candidates before selecting final operational budgets.
- Repeat with reviewed synthetic producer mixes and paired execution load once that
  integration exists. These measurements do not approve capture, choose consent or
  retention policy, establish metadata provenance, or satisfy the pre-beta gate in #416.

## Limits and checks

Logical-time replay measures work per event and the resulting retained state. It
cannot measure idle five-minute RSS growth, GC cadence under naturally spaced arrivals,
OS sleep/wake, long-session saturation, clock drift or timer callback scheduling. The
expiry probe measures access-triggered batch expiry, not an independently scheduled
idle timer. Existing fake-timer tests cover idle and exact-boundary behavior, without
being native performance evidence.

The maximum-metadata fixture is an independent serialization stress case. The current
buffer emits unknown versions, empty entities and enum-only events; it cannot construct
that richer report or reserve its future envelope automatically. No inference about
future producer authorization or the adequacy of that future reservation is made.
The JSON parser and file writer are benchmark surrogates: no actual preview UI, IPC,
permission dialog, file-save implementation, native ACL/encryption, upload path or
accessible rendering is measured. The temporary filesystem here is **tmpfs**: write +
`fsync` times are local memory-filesystem measurements, not physical-disk durability or
native export performance. There is no compression.

This is one shared Linux host without CPU isolation or a paired workload. Sub-microsecond
results include timer overhead, small sample quantiles are unstable, forced GC changes
normal scheduling, and trials do not establish confidence intervals or a leak-free
long session. The sampled RSS/heap guard does not prove absence of peaks between checks.
A sandbox-restricted attempt failed before workload execution on subprocess permission;
an exploratory run is discarded. The published run uses local subprocess permission,
a committed harness and no overlapping checks launched by this task.

Passed locally: compiled TypeScript project build; 24 buffer unit tests; 12 offline
contract tests; full repository typecheck, lint and format check; harness assertions
in all 24 measured trials and their warm-ups; 15 independent maximum-fixture validator
invocations; `git diff --check`. Harness JavaScript uses the repository's plain-JS
lint configuration and is not itself included in TypeScript's project.

The complete application test suite, renderer build, desktop packaging, native UI,
physical-device and network-observation acceptance were not run for this benchmark-only
change. Existing production files are unchanged. CI status is reported on the draft PR;
local benchmark evidence does not substitute for #416's remaining acceptance.
