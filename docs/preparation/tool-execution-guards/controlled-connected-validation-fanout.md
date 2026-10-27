# Controlled connected validation fan-out — #706 preparation

Independent investigation of why the controlled connected Save flow generates
excessive repeated validation work. Refs #699, #706 (with #702/#703). Starting
point: `6a4d30dda73be89b90b7684a821d18768dcc2e14` (tree
`1584948cf2add6891575506cc57f0e73f25ff42b`), reviewed observer source pin
`fa25390e8a88e23a33640f40404b6da58938bdb4`. Nothing here is an observer
attempt, an accepting token, production eligibility or a connected acceptance.
[Measurements](controlled-connected-validation-fanout.json) are retained beside
this file.

## Outcome

- The volume is a **multiplicative fan-out of complete currentness checks**, not
  one hot loop. The managed owner's own root re-resolution dominates each check,
  and two exact duplicates in the disposable composition multiply it by four.
- Three changes remove only exact duplicates (A, D1, D2). They cut bootstrap trace
  volume 104.8 → 34.7 MiB and Save 287.8 → 93.8 MB, but the full connected flow
  still exceeded 256 MiB and the unchanged 55-second owner expiry refused it.
- A fourth change (B) is an **explicit decision point**: the managed owner's
  assertion path observes each current fact once per invocation instead of
  bracketing its marker reads with two complete checks. With A+D1+D2+B the full
  connected flow completed under the enforced 256 MiB file cap and a 60-second
  process deadline: 216.3 MiB, 46.4 s, exit 0 (diagnostic driver, strace 6.8).
- The reviewed pins deliberately refuse this candidate. Independent review,
  then a coherent repin, rebuild and one fresh observation with the reviewed
  strace 6.13 tracer, are still required.

## Environment and identities

| Item | Value |
| --- | --- |
| Node / pnpm | 24.21.0 / 12.4.2, `--frozen-lockfile` (ACP SDK 1.8.0, Zod 4.6.7) |
| Kernel | Linux 6.18.44 |
| Rebuilt reviewed image at the start commit | child `9c3e6236…13e8b`, producer `d0ad8d81…1ec92`, manifest `9e37d858…86cd6` |
| Reviewed manifest | 386 inputs (194 repository, 192 dependency); rebuilt bytes identical to [`controlled-child-repinned-build.json`](controlled-child-repinned-build.json) |
| Installed tracer | **strace 6.8** (distro), which also lacks `--always-show-pid` |

`controlled_observation.observe_new()` at the exact start commit refused at
preflight, `RuntimeError: unreviewed tracer version for entry clock provenance`,
before any child launched. That refusal is correct and was not waived. It was the
only `observe_new()` call. No other tracer was installed, and no child ran under
the observer in this environment.

## Method (diagnostic only)

A driver outside the observer used the observer's own `prepare()` and
`prepare_connected()` plans, a real supervisor flock and command/ack pipes, a
synthetic 1,167-byte receipt and a synthetic `ConnectedDesignation` whose closure
returns `None`. That designation is not bootstrap authority. For candidate images
only, the driver bypassed `assert_image_sources`, which correctly refuses them.

- **Census**: an untraced preload wrapping synchronous `fs` calls. It recorded a
  real JavaScript stack at every child check, identified by its single
  `/proc/self/fdinfo/<lifetime>` open, split by command-FIFO phase. With a no-op
  async hook enabled it also recorded promise-continuation boundaries.
- **Syscall counts**: `strace -f -c`. These are counts, not trace bytes.
- **Trace bytes**: `strace --absolute-timestamps=format:unix,precision:ns -f -q
  -v -x -s 131072`, the observer's flags minus `--always-show-pid`. A strace 6.13
  trace may differ slightly in line length.
- **Enforced-limit run**: the same, plus the supervisor's `prlimit
  --fsize=268435456:268435456 --core=0:0`, `--kill-on-exit` and a 60-second
  whole-process deadline.

Owner expiry stayed 55 s, the lease 60 s, the trace cap 256 MiB. No currentness,
credential, policy, lease, resource, seal, root or final-dispatch check was
disabled for measurement. This environment traced about 2× slower than the one
that reported the 24.45-second cap: baseline Save took 48.3 s here. Raw traces
and census files stayed in the ephemeral session scratchpad and are **not**
retained evidence.

## Measured call graph

These are real stacks from the census, not inferred from source.

```text
readCaptureFacts (owner)      ≈ 20 inspect   binding(), read, facts, read, binding(), currentFacts
currentStore() (gate)         =  5 inspect   inspect; provider: binding.assertCurrent, checkCurrent (2), binding.assertCurrent
typed-sidecar read()          =  3 inspect   check, check, assertOwnerCurrent
binding.assertCurrent()       =  1 inspect   assertCompatibilityCurrent → assertMarker → inspect
inspect() (enrolled)          =  2 managed   owner check, marker reads, owner check
managed assertCurrent()       =  2 producer  lifetime port (check) + build port (check) + root re-resolution + identity
producer check() (connected)  =  2 child     assertCurrent (child check) + bootstrap.assertCurrent (child check + receipt)
child check()                 = 18 statx, 3 openat, 4 read, 3 close
```

At baseline, one `currentStore()` therefore costs 40 child checks, and one
`readCaptureFacts` about 160 (20 inspects). `readCaptureFacts` alone produced 40.8% of all
producer checks; managed `assertCurrent()` was the caller of 85.9% of them.

## Cost model

Exact per-unit costs at the observation layout depth were measured with marker
syscalls:

| Unit | Baseline statx | Notes |
| --- | ---: | --- |
| `resolveManagedRootBinding` | 96 | lstat walk to `/` plus a realpath walk, for 8 paths with shared ancestors |
| Managed identity tail | 31 | same ancestor walks again |
| Producer `check()` (connected) | 41 | 2 × 18 child + 1 receipt + 4 credential-file stats |
| Inspect marker reads | 27 | two bounded marker reads with ancestor walks |

For Save, the model `1,139 managed × 127 + 2,717 producer × 41 + 570 inspects ×
27 + ≈5k other = 276.6k` matches the measured **276,647** statx. That split is
52% gate re-resolution, 40% producer checks and 6% markers. Statx is 92% of trace
bytes, at about 958 bytes per line. The full connected flow at baseline is about
950k statx (modelled). At the measured 1.0–1.04 KB of trace per statx (the
reported capped run, and this Save), that is roughly 3.4–3.7× the cap.

This refines the starting hypothesis. The roots/ancestors share is mostly the
**managed gate's** ancestor walks, which repeat each component twice per path
and eight times per resolution. It is not the child's image checks, which are 3
of 18 child statx.

## What is redundant and what is required

| Repetition | Classification | Treatment |
| --- | --- | --- |
| realpath walk after lstat walk; shared ancestors re-walked per path; `lstatSync(idPath)` right after the same post-read lstat | duplicate observations inside ONE check invocation, the reviewed precedent class of the child stat consolidation | **A**: one observation per distinct path per invocation |
| `bootstrap.assertCurrent` re-running the whole child check immediately after `assertCurrent` | exact composition duplicate | **D1**: association checks only its own facts |
| managed build port receiving the complete `check` immediately after the lifetime port received it | exact composition duplicate | **D2**: build port gets a genuine image/proof check |
| assertion path (`assertMarker`) bracketing marker reads with two complete owner checks | duplicate within one assertion invocation; markers are compared with the retained marker, never returned | **B**: decision point, one check per assertion |
| `inspect()` bracket for state that is returned for use | read-consistency boundary | kept |
| re-checks after awaits (provider, typed-sidecar read, owner `binding()`, `readCaptureFacts`) | separate boundaries; other async chains can run effects between | kept |
| same synchronous turn, no intervening fs I/O (69% of consecutive producer-check pairs, A+D1+D2 working build) | not provably effect-free; external processes can mutate and a runtime memo cannot know | no memo, flag or cache |

## Approaches compared

All measurements use the same driver and strace 6.8. "Expiry" means the fence's
lifetime timer reached the unchanged 55-second `expiresAt` and refused, which
fails closed.

| Candidate | Bootstrap | Connected | Result |
| --- | ---: | ---: | --- |
| start (reviewed source) | 104.8 MiB | Save alone 287.8 MB; 340.9 MiB at refusal | human-read `choose` returned `uncertain` at 59.5 s |
| A only (`93ac60d`) | 43.9 MiB | 285.9 MiB at refusal | expiry in human-read |
| A+D1+D2 (`ec1f91a`) | 34.7 MiB | 263.6 MiB at refusal | expiry in rule-read |
| **A+D1+D2+B (`7c478c2`)** | **23.7 MiB** | **216.3 MiB, all phases** | **completes; 46.4 s under enforced cap/deadline** |
| experiment: remove `inspect()` bracket everywhere | — | 207.8 MiB | completes, 43.5 s; rejected: read-for-use state loses its bracket |
| experiment: lifetime port narrowed to lifetime facts + credentials | — | 238.7 MiB | completes, 53.6 s; rejected: 7% margin, drops supervisor facts from managed checks |

Not attempted: raising limits, dropping or abbreviating trace output, moving
phase boundaries, or caching across invocations. These are excluded by the
acceptance boundaries.

Restructuring product fan-out (owner `readCaptureFacts`, provider/`currentStore`
chains, service `current()`) is broader. Its provably adjacent duplicates are
about 10% of same-turn pairs.

## The changes

**A — `typed-workspace-gate.ts`, commit `93ac60d`.** `canonical()`,
`directory()` and `metadata()` take an observation map local to one invocation.
Each distinct path gets one fresh `lstatSync`, from which the symlink, directory,
uid, mode and identity fields are derived. The realpath walk is removed: a
normalized absolute path whose every component is observed as a non-symlink is
its own realpath. `metadata()` returns its always-fresh post-read `named`
observation. Each `assertCurrent()` creates a new map after its ports run.
`resolveManagedRootBinding` creates its own map. Nothing is shared between
invocations. Production imports only `assertNoUnownedTypedWorkspace`, which is
unchanged. Measured: one resolution 96 → 16 statx; one never-typed inspect
141 → 30.

**D1/D2 — child and producer, commit `ec1f91a`.**

- The child's `bootstrap.assertCurrent` is now `association`: retained-proof
  identity, bytes, proof digest and inventory digest. It no longer calls
  `check()`.
- A new `assertBuildCurrent` checks the installed image stamps and, when
  connected, the association.
- The producer retains it before any await and passes it as the managed build
  port. The lifetime port keeps the complete `check()`, so every fact a managed
  check observed is still observed in each invocation.
- Every producer `check()` and phase boundary still runs the complete physical
  check.

**B — decision point, commit `7c478c2`.** `enrollment()` is one complete owner
check followed by the marker reads. `inspect()` is `enrollment()` plus the
closing check for enrolled state, for `currentStore`, `openStore`, `dispatch` and
`enrollFresh`. `assertMarker()` uses `enrollment()`. Consequence: a change made
*during* an assertion's marker reads is refused by the next assertion, or by any
read-for-use inspect, not by that same assertion. This is the property every
consolidation within one check accepts, and it is the decision Cal and the owner
need to make.

Preserved unchanged: credential, revocation, expiry and scope checks; policy
revision and rule checks; lease ownership, epoch and bytes; cancellation; root
and enrollment identity; retained resource-descriptor identity and stamp;
protected-record seals; the final pre-dispatch checks; Save persistence review
separate from execution judgment; phase acknowledgement order; the 55 s, 60 s and
256 MiB limits.

## Before and after

Connected-flow unit counts come from the untraced census:

| Unit | Baseline | Candidate |
| --- | ---: | ---: |
| Child checks | 18,430 | 3,451 |
| Producer checks | 9,212 | 3,445 |
| Managed owner checks | 3,955 | 2,143 |

`strace -c` statx counts:

| Lane | Baseline | Candidate |
| --- | ---: | ---: |
| Bootstrap | 108,682 | 21,523 |
| Connected | 466,748 (Save plus partial human-read; refused) | 193,923 (complete) |

Untraced wall time for the connected lane was 6.0 s at baseline and 3.2 s for
the candidate. These are runs in one environment, not a controlled causal timing
claim.

Candidate full trace by phase (enforced-limit run): Save 65.7 MB, human-read
100.6 MB, rule-read 58.9 MB, init 1.6 MB. All 12 traced threads exited 0; none
were killed.

## Tests actually run

- Vitest (`typed-workspace-gate-observations`, gate, owner, live integration,
  controlled producer, fdinfo): **119 passed** at `7c478c2`. That includes 20 new
  gate observation controls and 1 new producer control.
- Each commit's own state also passed its suites: 117 at `93ac60d`; 60 targeted
  plus 10 Python at `ec1f91a`.
- Mutation checks against deliberately faulty gates were all caught: a
  cross-invocation cache, no symlink check, the assertion keeping its bracket,
  inspect dropping its bracket, and a map shared across inspect.
- Faulty child variants were all caught: association without the identity check,
  build port without the image check, and association repeating `check()`.
- The producer refuses when only the build port changes after Save, and never
  calls the proof check without the complete check immediately before it.
- Python: **329 run, 323 pass.**
  - 4 `test_controlled_image_pins` controls refuse by design. The working tree
    no longer equals the reviewed `SOURCE`, and `assert_image_sources` requires
    that.
  - 2 `test_kernel_runtime_queries` errors are environmental: there is no cgroup
    `memory.max`. They fail identically at the start commit, which runs 328 with
    326 passing.
- `tsc --noEmit`, ESLint and Prettier on changed files: clean.

## Limitations and decisions still needed

1. **B needs explicit owner review.** If it is rejected, A+D1+D2 alone is
   measured insufficient. Experiment 2 completes, but with thinner margin and
   weaker managed checks.
2. **Not observer evidence.** This used strace 6.8, a synthetic designation, no
   kernel/semantic replay and no bootstrap closure. Source inspection found no
   per-check grammar in the replay. Reads are validated generically against
   retained bytes, and fewer syscalls only remove events. Whether replay accepts
   the candidate trace is unverified.
3. **Margin.** 216.3 of 256 MiB is about 15% headroom, and 46.4 s against the
   55-second owner window in this slower environment. Path lengths and the tracer
   build change trace bytes.
4. **Consolidation semantics.** A transient change that lands between two former
   duplicate observations inside one invocation, and is reverted before the next
   invocation, is no longer seen. This is the same class accepted for the child
   stat consolidation. Every effect site keeps its own final checks.
5. **Unexercised.** The zero-result private-wake boundary case from
   `6a4d30d` is not exercised here.
6. **Repin after review only.** Set `SOURCE` in `controlled_supervisor.py`,
   `controlled_connected.py` and `controlled_timestamps.py` to the reviewed
   commit, and set `CHILD_SHA` to
   `7729c6faa7cca7436c0d7ab3008fd4532e3ed3d11e9c4ec01e98c04004782b13` and
   `PRODUCER_INPUT_SHA` to
   `42597750deea858c41a8c19a1eb12870b71f6ee737409e2fc46e6173ce61c5d6`. Then
   rebuild one image (here: producer `ef9e795e…0909`, manifest `51fc0c8b…6580`,
   192 dependency inputs identical to the reviewed build), review its manifest,
   and run one fresh observation with strace 6.13. Historical traces, receipts
   and records are unchanged.
