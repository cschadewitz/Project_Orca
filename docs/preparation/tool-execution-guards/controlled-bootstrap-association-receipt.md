# Compact bootstrap association receipt — preparation only

Refs #699 / #706 / #768. This separate proposal starts at exact PR768 head
`3869aef0b3427c1b8ffc6fb0dbc1ef667917caad`. The [fresh observation](controlled-connected-fresh-observation.md)
still ends with connected Save refused at the unchanged 60-second process bound.
No fresh traced bootstrap/connected attempt is part of this change. Parent
independent review must precede any further original execution.

## Narrow change and retained evidence

`ObservedRun.designate_bootstrap(image)` constructs a compact, exclusive-created,
mode-0400 `bootstrap-association.json`, capped at 4096 bytes, after the same original
run's closed-graph and authenticated bootstrap checks. The existing
`ConnectedDesignation.evidence_path` designates that receipt. Complete report,
originals packet and raw trace remain in their original files; none is truncated,
rewritten or added to the child's repeatedly read `originalFiles` inventory.

Initial receipt capture retains the original writer descriptor through flush,
fsync and the first named snapshot. Full descriptor stamps before and after that
snapshot must equal its physical stamp; bytes must equal the serialized receipt,
with mode 0400, a single link and the original size within the 4096-byte cap.
Corruption or same-bytes replacement before the first snapshot cannot become
the retained baseline. The descriptor checks also bracket mutation during the
named observation.

The receipt contains the exact original evidence reference, bootstrap base, pinned
producer source commit, observer implementation digest, all three image-member
digests, and paths/digests for the report, originals packet and trace. Its trace
digest and size must agree with both the original report and completed kernel
replay. Image identity/bytes/build must agree with the original retained inventory
and existing reviewed-source checker. Serialized report/original bytes must agree
with the actual original run's retained objects before publication.

The retained callable closes over that same `ObservedRun`. At each supervisor
designation boundary it reruns the original closure/authenticated-correlation and
observer assertions, rejects a returned success flag, compares retained in-memory
objects, freshly hashes every complete original evidence packet, and freshly
checks the image and receipt bytes/physical stamps. Replacements with identical
bytes, in-place changes, symlinks and hardlink aliases refuse. A copied report or
parsed receipt cannot reconstruct the original closed graph or this callable.
Exclusive creation refuses receipt replacement on repeated publication. These
remain cooperative same-UID source assumptions; file mode and hashes grant no
portable authority or accepting outcome.

## Exact currentness path stays intact

The unchanged producer's `check()` calls the child's `check()`, then connected
`bootstrap.assertCurrent()`. That bootstrap callable calls the child's `check()`
again and independently reads/hashes the designated proof. Every child check
still checks the original lifetime descriptor/name/flock, roots, fresh original
file bytes/hash, image physical stamps and control descriptors. Typed workspace
currentness still invokes both lifetime and build currentness; both producer
ports still call `check()`. Credential/revocation, lease, sidecar, root, resource,
cancellation, protected-store seals and all per-call checks remain unchanged.

The producer, child, build script and typed workspace currentness source remain
byte-identical to producer commit `557f62fbe86fc8371d48f11ec37bf9db71cac436`.
There is no stamp cache, successful-check cache or performance refactor. The
55-second owner, 60-second process and 256 MiB trace limits, original lifetime and
all authority/physical/clock/notification protections remain unchanged.

## Byte comparison, without a timing claim

The previous owner's source-plus-trace accounting found 1579 producer checks,
3162 child checks and `1579 * 3 + 5 = 4742` evidence reads. Those are inferred
call-graph correlations, not sampled call stacks. The original full report was
5906 bytes, totaling 28006252 decoded read bytes at that count.

| Evidence substituted at the historical read count | Bytes per read | Decoded bytes for 4742 reads |
| --- | ---: | ---: |
| Historical complete report | 5906 | 28006252 |
| Maximum permitted receipt | 4096 | 19423232 |

At that same count the receipt bound saves at least 8583020 decoded bytes
(30.65%). This is byte arithmetic, not a measurement of a new original attempt
or a guarantee that its check count or elapsed time will match. The failed trace
was 81.53% `statx` entries, so this proposal alone cannot establish a timing pass.

A synthetic closed-run fixture measures a 62605-byte complete report and a
1294-byte canonical receipt, while preserving every original file/stamp. A
separate synthetic control executes the exact unchanged child with a stub
producer, a real supervisor flock and command/ack pipes. Its 21 instrumented
proof reads remain 21 for both inputs: a 52000-byte synthetic report causes
1092000 bytes read; a 33-byte synthetic association causes 693. The initial child
check precedes instrumentation. These tests establish the repeated read/hash
path and byte substitution; the stub establishes no service or authority result.

## Validation and limits

The Python suite includes receipt/report/raw replacement, tamper, source/image/
report/trace mismatch, wrong run/replay, aliases, original closure loss, success
flags and copied-report controls. The unchanged child controls reject changed
proof bytes, physical replacement and wrong proof/inventory association. Injected
pre-first-snapshot corruption, same-bytes replacement, mode/size changes and
mutation during the named observation refuse; a positive control confirms the
original synced writer remains open through first capture. Results:
294 Python tests, 49 optimized connected controls and three optimized child
controls pass. Run:

```sh
python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_*.py' -q
python3 -O -B -m unittest discover -s tools/owned-read-proof -p 'test_controlled_connected.py' -q
python3 -O -B -m unittest discover -s tools/owned-read-proof -p 'test_bootstrap_receipt_child.py' -q
```

Focused existing Vitest producer/typed-workspace controls pass (42 tests). The
fdinfo file initially has eight failures because Node reports a negative inode
for the workspace fixture; all 19 unchanged fdinfo controls pass from a temporary
archive of the exact PR768 head on `/tmp`. Node is 24.19.0 and installed Vitest
is 5.0.2. `pnpm exec` failed attempting package-manager initialization outside the
workspace; tests use the existing installed runner directly, without installing
or changing dependencies. `git diff --check` passes.

No provider credentials, activation, live traced attempt, Mac work, PR metadata,
main merge or deployment is performed. Connected acceptance, timing validation
and independent aggregate review remain outstanding.
