# Fresh stat-consolidation observation — bootstrap refused

Refs #706. One authorized fresh observation ran at exact observer head
`109d1a4eb4b2bdc4bce991ea90bd03a59f142296`, using reviewed producer source
`fa25390e8a88e23a33640f40404b6da58938bdb4` and the
[reviewed candidate manifest](controlled-child-repinned-build.json). The
bootstrap child exited 0 and acknowledged its phase, but independent replay
refused `effect crosses phase boundary interval`. No bootstrap association
receipt was created, no connected process started and no connected command was
released. No second attempt ran.

This new outcome is separate from the older environment's preflight mismatch and
all earlier traces. It changes none of those results. No source or dependency was
changed or installed to make this run match. The original observation root is
`/tmp/orca-706-stat-fresh-q653v741`; raw evidence remains private there.

## Exact preflight and execution

Before launch, all **386** source/dependency input hashes matched the retained
manifest; all **15** executable observer files matched their committed bytes at
`109d1a4`. The preserved image was physically copied into this new root, then
rechecked against the reviewed source and manifest. The same original three-file
image would have been retained across both lanes; connected never started.

| Image member | SHA-256 |
| --- | --- |
| Child | `9c3e6236a9007647142d5ca1d9a15cbb5209f344d9d47241ffea2e83d8d13e8b` |
| Producer | `d0ad8d81a7980364a4b6ae80c0876cce951104fb3323e7d1fc3fc2c01a21ec92` |
| Manifest | `9e37d858e04764d939642cdeb3d980091b7ec622a219e4e07a5eedf898386cd6` |

The fixed call was `controlled_observation.observe_new(root, diagnostic=True)`
with that new root containing only the verified image. Node was the preserved
24.21.0 binary; strace was 6.13. Owner expiry stayed **55 seconds**, each process
bound **60 seconds**, and trace cap **268435456 bytes**. Existing currentness,
policy, credential, lease, resource, seal, root and final-dispatch checks were
not changed. The existing one-second diagnostic configuration stayed at 8192-byte
reads and at most 62 samples. No packet analysis ran alongside the original
traced process.

## Bootstrap timing and observation counts

| Observation | Result |
| --- | --- |
| Producer exit / stderr bytes | 0 / 0 |
| Original process elapsed | 10748672698 ns (10.748672698 s) |
| Supervisor phase log | `sent: bootstrap`, `received: bootstrap` |
| Monotonic enclosure from before command write through after ack read | 9624922690 ns |
| Command-read resume prefix to ack-write entry prefix | 9624643494 ns |
| Raw trace | 104079017 bytes, 152882 raw lines |
| Decoded records / statx entry records | 145494 / 108673 |
| Complete ordered inventory passes after import probes | 1226: one initial stamp/hash pass plus 1225 currentness checks |
| Command FIFO / ack FIFO statx entries | 1225 / 1225 |

The full named no-follow inventory statx counts are build **1226**, child **1228**
and producer **1227**. The child and producer counts include their earlier import
probes. From the first build-inventory observation onward, filtered inventory
paths repeat exactly build/child/producer 1226 times. This is consistent with the
reviewed source's one fresh bigint observation per inventory object per check;
the FIFO observations also remain fresh on all 1225 checks. These are counts from
this new trace, not a projected reduction in an older trace.

The prefix span is an interval between actual strace entry/resume samples, not
an invented syscall-completion timestamp. The supervisor's original wall and
monotonic sample brackets are retained in the
[sanitized numerical record](controlled-child-stat-fresh-observation.json).
No causal speedup or timing acceptance is inferred from this distinct run and
bundle. Its refusal was not a timeout or trace-cap overrun.

## First refusal and limits of offline diagnosis

Full event replay reached its final phase-crossing post-pass, which refused a
worker `futex` with opcode `FUTEX_WAKE_PRIVATE`, returning 0. Its interval crosses
the original leader's bootstrap command-read interval:

| Event | Zero-based raw lines, entry through resume | Entry prefix ns | Resume prefix ns |
| --- | --- | ---: | ---: |
| Worker futex wake | 3400–3402 | 1793066197504617465 | 1793066197505041106 |
| Leader command read | 3401–3404 | 1793066197504699229 | 1793066198131365402 |

Offline replay of the retained original reproduces exactly the same refusal.
The wake is neither an accepted retained wait nor a permitted passive crossing.
No exception, passive classification, boundary movement or skipped check was
introduced to admit it. Its zero result is an observation, not authority to waive
the boundary rule.

The partial offline replay graph has 12 settled threads and one service object
with one read. Those partial counts do not establish completed kernel/semantic
acceptance. The final named physical checkpoint and authenticated bootstrap
correlations did not complete. The launcher's consequent
`missing permanently closed original bootstrap` safeguard refused designation;
its exit was 1. `bootstrap-association.json` is **absent**: there are no receipt
bytes or receipt hash to report. Connected Save, human-read and rule-read timings
and effect acceptance are unavailable because those phases never ran.

## Retained packet bytes and cleanup

| Original packet | Bytes | SHA-256 |
| --- | ---: | --- |
| `bootstrap/trace` | 104079017 | `4ef32094110e8299c2b983f9f649109e8123f207ac6b56bc2601d350b9c430a9` |
| `bootstrap-attempt.json` | 3061 | `72770ce17cad8a9e30d519512d15bf0b71dea15fcd1b8b2ba7602787fa7c6cca` |
| `bootstrap-originals.json` | 269855863 | `feb2991f5939c399450bd7ae481ea477f43a9b4883b57469089057c934fc77f4` |
| `bootstrap-diagnostics.json` | 23790 | `cd8ed0a5fd13e10617570500954ff1fb1c5c133d9fda0818a38fd689a407fe9b` |
| `sanitized-checkpoint.json` | 3048 | `20d793ddf90b0126d3650c78ee752ce85a47647756c629918febc4793ce42206` |
| `bootstrap-clock/clock-probe.trace` | 2833 | `20153bdd3dfd643d04e36ff2ff92db0498eb192c2ad7abe9df68d4de35338b1c` |

The originals packet includes separately bounded retained runtime assets; its
size is not the trace size. Raw packets, protected state, phase tokens and
synthetic credential material remain private. Published evidence contains only
allowlisted counts, hashes, timing samples and refusal coordinates.

Diagnostics retained 12 samples with no errors and a stopped sampler. The final
post-settlement sample identifies the pinned tracer and leader as exited. All
12 trace thread IDs and the original tracer PID were absent on post-run
inspection. The same original lifetime-file identity was exclusively reacquired
and released. No service directories or lock directories remain. Original image
bytes and full retained stamps still match.

Cgroup CPU usage increased by 10.101827 seconds with zero newly throttled periods;
all memory-limit/OOM event deltas were zero. These contextual counters neither
establish a performance cause nor override the refusal.

This publication changes documentation/evidence only. The executed observer head
already passed 319 Python tests. Original refusal reproduction, trace/count
analysis, exact packet hashing, image/input comparisons, cleanup checks and
`git diff --check` pass. A complete new bootstrap, connected effect closure and
independent aggregate acceptance remain outstanding. Accepting token is null;
production eligibility is false. No new retry, provider, Mac, live credential,
production registry, main merge or PR metadata operation occurred.
