# C3-01: current-main protected catalog preparation

Focused evidence for [#408](https://github.com/cschadewitz/Project_Orca/issues/408),
following [C3-01](../../reviews/2026-10-13-review-detail/C3.md). Runtime is main
`0f45181c52dfc4bf1edd0e4469ff688dedef9189`. No production code, persistence format,
security policy, runtime activation state or quotas change. This does not close #408.

The reviewed [#423/#432 harness](../persistence-baseline/README.md) remains intact,
including its historical runtime pin and retained evidence. This focused runner imports
its resource supervisor, limits, interval unions, statistics and rotating schedule.
The new child-only observers supply the previously missing builtin-boundary counts.

## Reproduce

Use Linux, Node 24 and the installed frozen-lockfile dependencies. `git`, `ps` and
`findmnt` must be available. Do not run other benchmarks or tests concurrently.

```sh
node node_modules/typescript/lib/tsc.js -b packages/store/tsconfig.json --force
node --test tools/benchmarks/persistence-baseline/self-test.js
node --test tools/benchmarks/protected-catalog/self-test.js
node tools/benchmarks/protected-catalog/run.js \
  --scratch /tmp --output /tmp/orca-c3-catalog-evidence
```

Output must be new and scratch must exist. The runner refuses source differences from
the pinned runtime outside its two new tool/document directories, including untracked
files. Do not relax that guard to measure another candidate; review a new pin explicitly.
It force-compiles core/store, hashes every compiled JS module in those packages and
verifies the manifest is unchanged after measurement. Source commit/tree, runtime tree,
harness/helper/lockfile/Node digests, commands, filesystem type, raw outcomes and
median/min/max/spread are recorded. It does not build or launch Electron or a daemon.

The inherited supervisor bounds the suite to five minutes, each child to 60 seconds,
scratch to 256 MiB/12,000 files, child RSS to 512 MiB (build: 2 GiB), output to 2 MiB,
and V8 heap to 384 MiB. Sampled one-second filesystem/process-group monitoring adds
host work. Cleanup removes only this invocation's disposable scratch tree. Only reports
and compiled artifact hashes are retained; stores, keys and payloads are never uploaded.

The requested workload stays fixed: one protected run, eight events, one input record,
one sensitivity overlay, 256 padding characters per update, and a separate public run.
Unrelated encrypted generation records vary through 0, 128 and 1,024. Generation records
exercise the same flat directory as unrelated event payloads without growing the target
history; record kinds can affect which arbitrary write-key witness gets read.
Fixtures use real public store exports and real encryption/durability. Logical content
is deterministic; keys, nonces, event IDs, payload references and overlay IDs remain random.

Three rotating rounds pair process-cold/warm read modes and observer-off/count modes
on separate fixture copies: 36 independent measurement children. Warm mode performs
the six read operations once before measuring. Process-cold means no explicit warmup
in that new process; only the first read starts with an empty ciphertext cache. Later
operations share the process's cache. Neither mode is storage-cold: fixture creation/copy
heats the OS cache, and nothing evicts it. Appends always follow reads; their timing is
not a cold-append comparison. There are four simultaneous input readers in one measured
operation, no concurrent writers, and no daemon authorization-load measurement.

Observers forward builtin fs/crypto arguments, results and errors in disposable children
before dynamically importing the compiled runtime. Counters include actual returned
directory entries, file-handle reads by record kind, fresh key reads, crypto calls and
publication sync calls. No filenames, read buffers, keys or plaintext enter metrics.
Observer-off samples install no wrappers and supply the primary wall-time measurements.
Observers themselves add overhead; count-mode timings are attribution diagnostics.
Per-label interval-union times can overlap and must not be added into elapsed time.
Crypto timings cover the synchronous factory/method bodies only, excluding wrapper setup,
JSON parsing, schema validation, redaction and other CPU work. Public stream I/O is not
exhaustively observed. No unexplained residual is labeled crypto or validation time.

Every measurement verifies exact restored event types, run IDs, sequence numbers and
values, overlay membership, all four readers, filtered/tail output, public redaction,
public-only append behavior and authenticated protected append visibility. Count mode
also asserts the listing/decryption/key-read counts below. A failure is retained and
excluded from successful medians; raw exceptions are suppressed to avoid payload leaks.

## Recorded result

[Evidence](evidence/report.json.gz) contains all 36 passed samples and three passed
fixture setups. [Artifact hashes](evidence/artifacts.json.gz) cover 72 compiled modules;
[SHA256SUMS](evidence/SHA256SUMS) covers both compressed evidence files. Decode with
`gzip -dc docs/performance/protected-catalog/evidence/report.json.gz`.

Environment: Node v24.19.0, Debian 13.6, Linux 6.18.55, x64, five visible CPUs,
Intel Xeon Platinum 8573C, `/tmp` tmpfs. No physical-media or power-loss claim follows
from this run. Timings are diagnostic for this host and workload, not a regression budget.

With C unrelated records the catalog contains C + 11 entries (ten target records and
one key). These counts held in every observed sample, across both read modes:

| Operation | Full directory listings | Names returned at C=0 / 128 / 1,024 | Decrypt calls | Fresh key reads |
| --- | ---: | ---: | ---: | ---: |
| Get inputs | 1 | 11 / 139 / 1,035 | 2 | 2 |
| Protected public read / types / tail, each | 1 | 11 / 139 / 1,035 | 3 | 3 |
| Restore eight protected events | 1 | 11 / 139 / 1,035 | 10 | 4 |
| Four simultaneous input reads | 4 | 44 / 556 / 4,140 | 8 | 8 |
| Public-only append | 1 | 11 / 139 / 1,035 | 0 | 0 |
| Protected append | 4 | 44 / 556 / 4,140 | 8 | 8 |

Protected append performs three input/overlay lookups (entry, previous payload
validation and new payload validation) and one write-key witness listing. It encrypts
one record. Unrelated ciphertext is **not** fully read or decrypted: the write path
authenticates one arbitrary existing witness, while input/overlay/payload validation
handles target records. Ciphertext-cache hits can avoid record-byte reads; they still
require current identity/permission checks, fresh key bytes and authentication.
The measured listing is all names, not a full catalog-content read.

Observer-off append wall time, milliseconds; three samples per cell, median [min, max]:

| Unrelated records | Public append, process-cold read sequence | Protected append, process-cold read sequence | Public append, warm read sequence | Protected append, warm read sequence |
| --- | ---: | ---: | ---: | ---: |
| 0 | 3.991 [3.928, 4.739] | 12.214 [11.234, 12.407] | 4.929 [4.532, 5.385] | 12.183 [9.506, 15.047] |
| 128 | 5.056 [4.739, 6.939] | 14.671 [10.656, 19.056] | 4.215 [3.871, 5.509] | 12.072 [9.328, 13.910] |
| 1,024 | 4.975 [4.450, 18.439] | 17.466 [14.388, 32.217] | 5.614 [4.815, 6.420] | 12.512 [9.270, 14.014] |

For warm, observed protected appends, directory-list interval-union median grows
0.336 → 0.707 → 1.611 ms; synchronous crypto body time is 0.590 → 0.924 → 0.649 ms.
These are separately measured diagnostics, not additive elapsed-time shares. Wall times
overlap substantially, especially warm. The strongest evidence is deterministic O(C)
returned-name work at fixed requested history and constant cryptographic operation count.
Repeated growth is consistent with quadratic cumulative enumeration, but this bounded
run does not measure 250k-file stores, long-daemon behavior or event-loop blocking.

## Smallest proposed follow-on

Keep this PR benchmark/docs only. No measured before/after optimization or safe quota
increase is established. Skipping input reads for a remembered public run, caching
overlay absence or reusing keys across calls could miss promotion, revocation or
same-tick key replacement. Those shortcuts are not proposed.

The smallest next candidate is confined to `protected-file.ts:keyFor(create=true)`:
evaluate incremental `opendir` enumeration to select the existing single `.json`
write-key witness instead of materializing the entire directory with `readdir`.
Retain the fresh key read, missing-key second read/first-key race behavior, witness
authentication and current file/directory identity and mode checks. Close the iterator
on every path; propagate enumeration failures fail-closed. The missing-key/no-record
case must still scan to completion. This may reduce one full-list allocation on the
common write path; it does not bound the other three overlay scans, promise a fixed
number of directory entries examined, or solve long-term catalog growth.

Before implementing that candidate, prove equivalent authority under concurrent record
publication/removal, iterator failures and witness selection changes. The current full
`readdir` supplies a completed enumeration before choosing its arbitrary witness;
early stopping changes that observation boundary. Without those proofs, do not call
this a harmless enumeration substitution. Evaluate both variants with paired rotating
source order, this exact fixed-history catalog series and a durability-enabled physical
disk run. Record iterator entries examined as well as listings and all outcomes.

Acceptance must retain same-tick equal-metadata key mutation checks, deterministic
mid-batch deletion/replacement/unsafe-mode barriers and no-partial-plaintext behavior;
cross-call promotion/new-overlay/removal checks; malformed/tampered witness and payload
refusal; independent concurrent batches; first-key races; publication/fault-injection
and file/directory/ancestor sync guarantees. Existing entry/terminal observation semantics
do not detect every transient A→B→A change. No sharding, migration, retention,
long-lived cache authority or privacy changes are included in this follow-on candidate.

## Validation and limits

The new observer/compiled-worker self-tests pass (2/2); inherited #423/#432 self-tests
pass (8/8). All 36 benchmark samples pass with unchanged compiled hashes. Core/store
force-compilation and changed-tool ESLint/Prettier checks pass.

Local store suite: 456/457 pass across 31 files. The unchanged legacy-workflow test
at `packages/store/test/protected-execution-store.test.ts:216` expects `0755` after a
fixture `mkdir({mode: 0755})`; this environment's preserved `0077` umask produces
`0700` (448 versus expected 493). No permissions, test expectations or umask were
changed to make it pass. The replay/key/identity/overlay and publication suites passed.
The same single failure reproduces when that file runs alone (12/13 pass). Repository
TypeScript checking also stops at `packages/app/src/main/first-run/setup.ts:14` because
the preinstalled dependency tree lacks the app's declared `yaml` dependency; core/store
compilation succeeds. No dependency manifests or lockfiles were changed for this probe.
No `.agents/skills` directory was provided in the repository or workspace.
This is not a green full-suite claim. Native UI, physical disk, storage-cold, power loss,
large histories and a candidate speedup remain unverified. Final remote CI status must
be read from the actual PR commit, independently of these recorded local results.
