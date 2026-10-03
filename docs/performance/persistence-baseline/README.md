# Bounded persistence baseline

This is the profiling slice [#423](https://github.com/cschadewitz/Project_Orca/issues/423)
of [#408](https://github.com/cschadewitz/Project_Orca/issues/408). The harness owns only
`tools/benchmarks/persistence-baseline/`; evidence and instructions live here. No runtime,
API, store format, credentials, shared test timeout, coverage threshold or CI changes.
See [the recorded baseline](baseline.md) and [report template](evidence-template.md).

## Reproduce

Use an installed, lockfile-pinned checkout with Node 24 (Node 22 is not measured here).
The supervisor currently supports Linux, with `git`, `ps`, `findmnt` and `lsblk` on PATH.
It deliberately refuses runtime changes relative to approved main
`e94bf699d9f3000de8822ed3434c1dce92b6ce19`. Adding the harness and evidence in the two
owned paths is allowed. Candidate testing requires a separately approved source pin;
do not transplant an active peer branch or label it main.

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
node node_modules/typescript/lib/tsc.js -b tsconfig.build.json --force
node --test tools/benchmarks/persistence-baseline/self-test.js
node tools/benchmarks/persistence-baseline/run.js --profile smoke \
  --scratch /tmp --output /tmp/persistence-smoke --seed 423
node tools/benchmarks/persistence-baseline/run.js --profile baseline \
  --scratch /tmp --output /tmp/persistence-tmpfs --seed 423
node tools/benchmarks/persistence-baseline/run.js --profile baseline \
  --scratch "$PWD" --output /tmp/persistence-disk --seed 423
```

The output directory must not exist. The scratch parent must already exist. Each
invocation force-compiles the TypeScript project graph, records its command and exit,
hashes all compiled workspace JS/CJS/JSON artifacts, and measures only those compiled
exports. The initial standalone build above supplies the self-check's prerequisites.
This is not an Electron/package build. Run filesystem cases sequentially on an idle
machine; do not run tests or a second benchmark alongside the measured baseline.
Confirm the recorded mount type instead of assuming `/tmp` is tmpfs or `$PWD` is disk.

`report.json` contains exact source commit/tree, approved runtime commit/tree, observed
`origin/main`, dirty-path disclosure, harness/lockfile/Node digests, CPU/OS/Node/filesystem,
commands, limits, dimensions, raw samples, counts, outcomes and median/min/max/spread.
`artifacts.json` contains individual compiled-file SHA-256s and their aggregate; its own
digest is in the report. Copy only these evidence files, never scratch stores or keys.
Stdout/stderr from the demo and build are represented by digests and lengths, not retained
raw transcripts. A failing worker returns only an error code/name.
The supervisor records each child's full command, including `--max-old-space-size=384`,
and working directory. The older tmpfs/development reports list logical build/demo
arguments without that inserted flag; their hashed supervisor supplies it. Worker
arguments in those older reports are fixed by the runner and recorded dimensions/cache/seed.

## Workloads and interpretation

| Axis | Smoke levels | Baseline levels | Held fixed |
| --- | --- | --- | --- |
| Events per run, including creation | 8, 24, 64 | 32, 128, 512 | One run, no unrelated records, one reader |
| Runs with protected histories | 1, 4, 8 | 1, 8, 32 | Base history, no unrelated records, one reader |
| Unrelated protected generation records | 0, 32, 128 | 0, 128, 512 | Base history, one run/reader |
| Concurrent readers in one process | 1, 2, 4 | 1, 2, 4 | Base history, one run, no unrelated records |
| Combined | 24 events × 4 runs, 32 catalog, 4 readers | 128 events × 8 runs, 128 catalog, 4 readers | Same payload and overlay shape |

Base history is 8/32 events for smoke/baseline. Every run has one sensitivity overlay,
a synthetic secret input, and 256 padding characters per `vars.set`. Catalog growth uses
`putGeneration` in the same protected directory, so unrelated records grow without growing
the requested replay. Seed 423 determines logical run IDs and canary values; the dimensions
and content are deterministic. Cryptographic keys/nonces, event IDs and sensitivity IDs
retain runtime randomness. Ciphertext identity is intentionally not reproducible.

Each reader lists runs, reads inputs, requests an eight-event public tail, reads the full
public history, restores protected payloads through integrated `executionEvents`, and
reduces the state. It checks counts, final sequence/value and public redaction. After the
workload timer stops, an untimed oracle checks every measured reader's tail-page sequence
numbers and every restored event's run, sequence, type and payload, so omitted intermediate
restoration cannot appear as a speedup. Concurrent
readers each perform the same full inventory using independent calls on shared store
instances in one process; this is not multi-process contention or daemon authorization
load. One protected append follows the readers, then an untimed replay verifies visibility
and redaction. There are no concurrent writers. The compiled CLI `demo` separately runs
real local scripted ACP subprocesses (one smoke, three baseline invocations), never a
provider. Demo timings are end-to-end; there are no phase-attribution claims for them.

Fixtures are generated through public store exports in separate processes. Every sample
uses a fresh copy with exactly the same starting dimensions, then deletes it. Three rounds
rotate case order. Each case runs an adjacent process-cold/warm pair per round, and its
first cache condition reverses between adjacent rounds, keyed on its stable plan index
(`schedule()` in `model.js`; the self-check asserts this for both profiles). Three rounds
therefore give each case both orders, but 2:1 rather than perfectly balanced. This pairs
cache conditions at each size, not different source candidates. All rounds, including
failures, remain recorded. Summary statistics include only passed samples, with their count
and all outcomes alongside; three observations describe spread, not a confidence interval.

**Process-cold** means a new worker with empty process-local caches, after fixture copy.
**Warm** means one untimed complete read workload in that same worker first. Both have
recently touched OS pages; neither is a storage-cold measurement. Append receives read
warmup only, not a prior append. No global caches are dropped, no private cache is reset,
and no key cache is added. Cold-storage acceptance remains blocked until an approved host
can supply it. Keep filesystem/cache groups separate; never pool them into one median.

## Measurement boundaries

Timers and counts exist only at harness call sites. For each label, report the **union**
of its intervals across readers. The all-operation union and whole-workload wall time
are also separate. Do not add label times: different operations overlap across readers.
Assertions, loop work and scheduling gaps explain why operation union can be smaller
than wall time. Workload wall excludes import/startup, fixture setup/copy, warmup and the
untimed restoration/post-append oracles, although the measured readers' results stay
referenced until the restoration oracle runs; supervisor wall includes the whole worker. Setup and demo have their
own outcomes and supervisor timings. Instrumentation overhead is not subtracted.

| Observed label | What its duration includes | Attribution limit |
| --- | --- | --- |
| `run-list` | Public run inventory | Not private catalog scanning or daemon `runs.list` |
| `input-read` | Inputs and sensitivity reads, authentication and schema validation | No separate key/read/scan/decode counters |
| `public-tail`, `public-history` | Public log reads plus protected integrity guard | Public page size does not bound private integrity I/O |
| `replay-restore` | Integrated batch payload restore and validation | Not just decryption, nor complete interpreter replay |
| `reduce` | `reduceRun` projection | Harness call timing, not a sampled CPU profile |
| `protected-append` | Integrity, input reads, encryption, private publication and public append | No isolated fsync, key or catalog timing |

At the pinned source, `ProtectedEventStore.requireIntegrity` validates the latest protected
payload, `FileExecutionStore.getInputs` enumerates sensitivity records, and
`protected-file.ts` validates existing ciphertext before writes. `executionEvents` uses
`getPayloads`, whose multi-record path uses fresh entry/terminal observations for one call.
These are source-grounded explanations, **not measured counts of private I/O**. No shared
instrumentation hook is added. If #408 needs those counts, review a minimal diagnostic
seam separately: operation-scoped counters and monotonic intervals for key reads, directory
enumeration, validation, decode/authentication and publication, with no payload/key values,
no caching authority and no changed call order. Existing #408 already owns that work.

No newer integration-candidate read-snapshot seam is used or asserted here. Bounded public
pages and private I/O are different layers. The old #397 compiled-demo measurements at
`7abc2342`, `ce2c09a3`, and `74a068ec` are historical sources, not this main baseline and
not a paired comparison with it. The historical 55.7% allowance is not a current budget.

## Bounds, durability and evidence limits

- Fixed 15-minute suite and 60-second child deadlines, including the demo's existing
  bound; process groups are killed on timeout or resource failure. Later work is `unrun`
  after a suite deadline, not silently omitted as passing.
- Compilation has a separate 2 GiB process-group RSS ceiling. Workloads have 512 MiB
  RSS and a 384 MiB V8 heap cap. RSS is sampled once a second; subsecond samples can
  report zero sampled peak, while successful workers also report their own max RSS.
- At least 512 MiB free scratch space before starting; 256 MiB allocated scratch bytes,
  12,000 files and 2 MiB per stdout/stderr stream. Fixed dimensions cap generated work.
  A supervisor scans scratch and process-group RSS every second, so limits are sampled
  stop thresholds with possible overshoot, not kernel quotas. These scans add host I/O.
- Only a new `orca-persistence-*` child under the selected scratch parent is populated
  and removed. No existing store path can be passed to the runner. No production data,
  credentials or provider environment is forwarded. Interrupting the supervisor itself
  with SIGKILL can leave scratch state; remove only its known disposable child after
  verifying no owned process remains. Generated execution keys must never be published.
- Demo processes run inside their disposable directory with `GIT_CEILING_DIRECTORIES`
  set to the scratch root. This prevents the local workspace provider from discovering
  and switching a parent checkout's branch when scratch is on the worktree filesystem.
  The runner also verifies the original source branch after every demo and at completion.
- No durability switch is disabled. Private file, directory and ancestor syncs use the
  production paths unchanged. Public JSONL behavior is unchanged too; do not infer a new
  whole-transaction durability guarantee from private-publication fsyncs.
- tmpfs is never physical-disk durability evidence. A Linux disk-backed ext4 case can
  prove execution of unchanged publication paths, but mount/virtual block-device data
  alone cannot attest the host's physical media or power-loss guarantees. Report those
  unavailable proofs as blocked; #408's physical-disk criterion stays open.

This evidence reuses #402's distinction between source/build hashes and a signed packaged
artifact, and #403's explicit outcomes, synthetic isolation and prohibition on retaining
keys/private stores. It does not redo their portable artifact validator or Mac matrix.
Harness success is not optimization acceptance, a security-regression suite, packaged-app
proof, physical-Mac proof or a release approval.
