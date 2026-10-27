# Controlled child stat observations — #706 preparation

This narrow candidate starts at reviewed receipt
`434d29987f41e4b3b3d8ea550c58ea32af8de1b5`. It changes only the installed
child's inventory-file and command/ack FIFO observations inside each currentness
check. The TypeScript producer, observer grammar and runtime trust pins are
unchanged. No fresh traced original attempt ran.

Each inventory file now has one fresh `lstatSync(path, {bigint:true})`; identity,
regular-file type and full physical stamp derive from that same object. Each
command/ack descriptor has one fresh `fstatSync(fd, {bigint:true})`; FIFO type
and identity derive from that object. Identity fields convert to the existing
JSON-number representation. All nine stamp fields retain exact decimal strings,
including nanosecond mtime and ctime. Observations are local to one check; a later
check always observes again.

All currentness invocations, bootstrap proof hashing, pre/post phase boundaries,
root/lifetime/original-file checks and fdinfo queries remain. No reentrancy or
success flag is added. Mutable credential, policy, lease, resource and seal checks
in the unchanged producer retain their existing capture, qualification, final
authorization and physical dispatch boundaries. Owner expiry remains 55 seconds,
process timeout 60 seconds and trace limit 256 MiB.

## Exact synthetic call comparison

The actual base and candidate child bytes ran against the same synthetic producer
and real disposable flock/command/ack descriptors. Instrumentation began after
the initial check. Four direct and four bootstrap currentness calls plus both
checks around each of three phase callbacks exercised 14 checks of each child.
This measures synchronous filesystem API calls, not a new traced timing result.

| Targeted observations | Reviewed base | Candidate | Saved per check |
| --- | ---: | ---: | ---: |
| Three inventory files | 126 (9/check) | 42 (3/check) | 6 |
| Command and ack FIFOs | 56 (4/check) | 28 (2/check) | 2 |
| Total | 182 (13/check) | 70 (5/check) | 8 |

The supplied historical trace inventory is 2,316 inventory-check blocks and
140,378 statx calls. Multiplying eight by those blocks gives 18,528 potentially
removed calls; this is an estimate for that historical check count, not a fresh
trace count, runtime prediction or timing acceptance. No timeout, expiry, trace
budget or final dispatch check is relaxed.

## Controls and validation

`test_child_stat_observations.py` runs the exact repository child with a synthetic
producer. It requires one bigint observation per targeted object per check and
retains exact counts for every other currentness path, lifetime descriptor and
fdinfo query. All three image files are tested for real byte tamper with mtime
restoration, same-byte replacement, directory/symlink replacement, hardlink and
mode changes after eight successful checks. Each of the nine stamp fields is
also independently perturbed, including one-nanosecond changes. Both FIFOs get
real regular-file replacement and other-pipe identity substitution between
checks; isolated type predicates and all five identity fields are tested too.
There are 62 mutation subcases across the six new test methods.

The timestamp fixture now reads the child at its existing reviewed `SOURCE`
using `git show` instead of reading working-tree bytes while claiming the
historical `CHILD_SHA`. Its child-byte mismatch negative control remains strict.
This fixture adjustment does not promote this candidate into reviewed authority.
The reviewed source object must be available locally to run those fixtures.

Validation on Node 24.21.0, with dependencies matching the existing frozen lock:

- `python3 -m unittest discover -s tools/owned-read-proof -v`: **311 passed**.
- `vitest run packages/cli/test/controlled-owned-read.test.ts packages/cli/test/controlled-owned-read-fdinfo.test.ts --maxWorkers=2`: **40 passed**, in a fresh `/tmp` worktree containing this candidate's source changes and the same dependencies.
- Child ESLint and Prettier checks, plus `git diff --check`: passed.
- Two isolated three-file image builds: producer bytes and complete input-hash maps are identical between base and candidate at the same build root; only child bytes and the manifest's child hash differ.

The initial workspace Vitest invocation passed the 21 producer tests and 11 of
19 fdinfo controls; eight fdinfo cases failed because this overlay exposes
source-file inode values above signed 64-bit range that Node reports as negative
bigints. Those existing controls use a source file to stand in for the query's
positive inode. The fresh `/tmp` worktree has positive source-file inodes and
passes all 40 tests without source or assertion changes. No installed runtime or
traced acceptance is inferred from these fixture checks.

## New reviewed pin required

The matched local builds from `/workspace/Project_Orca` have these SHA-256 values.
These are preparation comparisons, not an installed-image trust designation.
Build output is sensitive to its build root and dependency inputs; retain and
review the actual new image's complete manifest before use.

| Physical file | Reviewed-base bytes rebuilt locally | Candidate bytes rebuilt locally |
| --- | --- | --- |
| `controlled-child.mjs` | `a58036e5343fe07dac8625f7d5dfc2a7e0c6bfe660ddb1e96711b5b8d002e35c` | `9c3e6236a9007647142d5ca1d9a15cbb5209f344d9d47241ffea2e83d8d13e8b` |
| `controlled-producer.mjs` | `d0ad8d81a7980364a4b6ae80c0876cce951104fb3323e7d1fc3fc2c01a21ec92` | `d0ad8d81a7980364a4b6ae80c0876cce951104fb3323e7d1fc3fc2c01a21ec92` |
| `controlled-build.json` | `f82b8a725762f9b880447320ed78a084818b0dc4c8232160a20da58386f239f1` | `9e37d858e04764d939642cdeb3d980091b7ec622a219e4e07a5eedf898386cd6` |

Independent source review must precede a new source/image designation and any
fresh traced attempt. The current `SOURCE` pins in `controlled_supervisor.py`,
`controlled_connected.py` and `controlled_timestamps.py`, and `CHILD_SHA` in
`controlled_timestamps.py`, still designate the older reviewed producer/child.
They deliberately refuse this changed child. After review, the owner must update
all applicable source/image bindings coherently, rebuild and retain one new
physical image, and recheck unchanged producer semantics and expiry ordering at
the exact reviewed head. Historical traces and receipts retain their old pins.
Fresh bootstrap replay and connected acceptance remain outstanding; this patch
grants no accepting token or connected command release.

## Reviewed source and disposable observer repinning

The initial preparation above remains a historical record of the candidate before
source review. Independent source review subsequently approved exactly
`fa25390e8a88e23a33640f40404b6da58938bdb4` within the fresh-stat consolidation
scope. This follow-up changes only these disposable test-observer pins:

| Location | Old value | New value |
| --- | --- | --- |
| `controlled_supervisor.py` `SOURCE` | `557f62fbe86fc8371d48f11ec37bf9db71cac436` | `fa25390e8a88e23a33640f40404b6da58938bdb4` |
| `controlled_connected.py` `SOURCE` | `557f62fbe86fc8371d48f11ec37bf9db71cac436` | `fa25390e8a88e23a33640f40404b6da58938bdb4` |
| `controlled_timestamps.py` `SOURCE` | `557f62fbe86fc8371d48f11ec37bf9db71cac436` | `fa25390e8a88e23a33640f40404b6da58938bdb4` |
| `controlled_timestamps.py` `CHILD_SHA` | `a58036e5343fe07dac8625f7d5dfc2a7e0c6bfe660ddb1e96711b5b8d002e35c` | `9c3e6236a9007647142d5ca1d9a15cbb5209f344d9d47241ffea2e83d8d13e8b` |

The producer input pin remains
`c9d4a7185bdb07d05b7f0ca192e65fc6efa574141862f3994c8cc35bbd584e86`.
No child or producer code changes in this follow-up. No production accepted-build
registry, credential, OS setting, timer, trace bound or release gate changes.

A new isolated image was built at `/tmp/orca-706-repinned-image` using the
unchanged builder and Node 24.21.0. The image was not executed. Its exact emitted
[complete build manifest](controlled-child-repinned-build.json) is retained here
for parent review, without reformatting. All 386 input hashes (194 repository
inputs and 192 dependency inputs) and emitted producer bytes match the prior
candidate build exactly. The three-file candidate image, including the manifest,
is byte-for-byte identical to the prior prepared candidate image:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `controlled-child.mjs` | 5426 | `9c3e6236a9007647142d5ca1d9a15cbb5209f344d9d47241ffea2e83d8d13e8b` |
| `controlled-producer.mjs` | 2183299 | `d0ad8d81a7980364a4b6ae80c0876cce951104fb3323e7d1fc3fc2c01a21ec92` |
| `controlled-build.json` | 47911 | `9e37d858e04764d939642cdeb3d980091b7ec622a219e4e07a5eedf898386cd6` |

The historical timestamp fixture remains available through
`historical_clock_original()` with its original source, child bytes and declared
hash. Its canonical sorted-JSON SHA-256 remains
`53bfcaef92557acfea26c147ca1e1f1584e4541409fd071cff761c4b62eeb2f8`.
Current synthetic controls use a separate fixture bound to the new reviewed
source. The current observer refuses the entire historical pair as well as all
seven mixed/noncurrent combinations of source, declared child hash and retained
child bytes. There is no historical fallback in runtime trust selection. Existing
historical traces, receipts and evidence files are unchanged.

`test_controlled_image_pins.py` builds a real three-file image and calls the actual
source checker and retained designation checks without mocking them. Controls
cover consistent repinned source/input correspondence, old and mixed child/build
pairs, bundle tamper, image/proof tamper and same-byte inode replacement. Connected
originals must retain the exact source, build, physical inventory bytes, proof and
bootstrap plan association; all seven targeted association mutations refuse.
The closure used in these synthetic association tests is explicitly synthetic,
not an observed bootstrap or authority to release a command.

Validation: **319 Python tests pass**, including existing compact-receipt,
authentication, clock/expiry, kernel, Save, delivery, child-call-count and tamper
controls. `git diff --check` passes. The earlier 40 producer/fdinfo results remain
applicable to the identical child/producer sources; no producer behavior changed.
The actual rebuilt image passes `assert_image_sources` at the new reviewed pin.
Image/file/input byte comparisons and manifest hashing pass. Parent review of
this exact manifest remains required before any fresh traced attempt. No fresh
trace, bootstrap designation from a real run, connected command, accepting token
or production eligibility is asserted by this repinning.
