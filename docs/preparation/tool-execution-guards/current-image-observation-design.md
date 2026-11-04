# Current-image inspection and observation design — preparation only

> Later preparation: [offline cleanup and privacy projection](current-image-cleanup-privacy.md)
> supersedes the inspector's cleanup helper and public-summary details below.
> The original no-live guards and unfulfilled live-qualification gates remain.

Base: `1b77e1a90483f71fcd08084c9f937b2b773854a0` on
`prep/706-current-main-nonlive`, draft PR #809. This increment implements offline
candidate inspection and closes pre-refusal side effects in the public wrappers.
It does not instantiate a current runtime designation, authorize observation,
replace the original bootstrap receipt, or enable any live entry point.

The user's authorization permits preparation design/implementation, independent
review and routine non-force preparation publication. Any live observer/tracer run
requires a separate decision on its exact environment, scope and unchanged limits.
App Smoke, production activation, merge, security-setting changes and bypass of
the #779/#793/#794 denials remain forbidden. Ordinary authorized PR CI, including
its compiled CLI smoke, is distinct from the forbidden App Smoke workflow.

## Implemented boundary

`current_image_inspection.inspect_current_image(absolute_path_string)` is a
standalone Linux-only offline reader. It imports no supervisor/launcher and has no
CLI, builder, observer, runtime probe, designation constructor, plan factory or
execution callback. Its fixed table identifies the already independently rebuilt
image, whose reviewed image-source model is
`4ebf382fe6738bb11268b47b048a3d7c7a6f2586`:

| Native artifact | Exact bytes | SHA-256 |
| --- | ---: | --- |
| `controlled-build.json` | 48027 | `889bd46eeec3bf3133bea022591d23ad4a627b2e7bfc73d71fd8c4ecc971d977` |
| `controlled-child.mjs` | 5713 | `17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13` |
| `controlled-producer.mjs` | 2248652 | `1c0bffce70e7bb70245962590f2f291b68b6afdd35078caa5fd25fbd573e5ff7` |

The complete raw-manifest hash fixes all manifest bytes for this one known build;
it does not trust expected hashes supplied by a caller or parse candidate JSON as
policy. This is correspondence with previously reviewed/rebuilt bytes, not fresh
independent source/dependency verification on each inspection. The separate
[identity matrix](current-main-qualification-identity.json) and
[independent rebuild](current-main-independent-rebuild.json) retain that provenance.
The existing legacy `SOURCE` selectors are unchanged; these constants do not repin
or broaden `ConnectedDesignation`.

The inspector walks each canonical absolute path component through non-following
directory descriptors. It requires the exact three names, with bounded enumeration
that refuses on the fourth entry. Files must be regular, single-link, owned by the
current user, not group/world writable, and exactly the pinned size. It first pins
each named inode with `O_PATH | O_NOFOLLOW | O_CLOEXEC`, checks the complete stamp,
then reopens only that validated regular inode through the trusted process's
`/proc/self/fd/<owned-fd>`. This deliberate procfd reopen is read-only, CLOEXEC and
nonblocking. Candidate pathname replacement cannot make that read-open target a
new device/FIFO. Unsupported platforms/flags refuse without a fallback.

Reads are bounded by exact size plus one byte to detect growth. Full stamps and
directory-entry associations are checked before/after reading, and all retained
file stamps and directory anchors are checked before returning. Each descriptor
is registered with an `ExitStack` immediately after acquisition, including before
the next stat/read operation. Cleanup attempts every registered descriptor even
if a close reports an error. A successful inspection closes all owned descriptors;
failure attempts every registered close and returns no snapshot if cleanup reports
an error. This does not guarantee recovery from every possible OS close failure.

`CandidateInspection` is a frozen temporal snapshot with `recheck()` and a fresh
descriptive `report()`. A recheck reopens/revalidates the exact paths and compares
original physical identities/stamps, so identical-byte replacement cannot reuse
the original snapshot. A new snapshot of a valid copy has no inherited continuity.
The report excludes input paths and raw errors/payloads, and always states:

```text
authority = none
acceptingToken = null
productionEligible = false
observationAuthorized = false
loadedImageVerified = false
```

The object is constructible and Python module state can be changed by trusted
same-process code. Neither the object, serialization nor its fields is an
authorization boundary. There is no consumer that treats them as permission, and
no `bind`, `association`, `authorize`, `execute` or `launch` method. Future code
must not convert this descriptive object/report into a capability.

The existing `observe()` unconditional refusal remains unchanged. The public
`observe_new()`, `diagnose_bootstrap()` and `bootstrap()` wrappers now also refuse
as their first executable statement, before git, build, argument inspection,
tempdir creation or delegation. Their historical bodies remain unreachable for
source review. Two wrapper tests now assert the stronger early refusal; the direct
original-closure/receipt tests are retained. All refusal strings are fixed text.

## Prevention, detection and loaded identity

| Boundary | Established now | Not established |
| --- | --- | --- |
| No live entry | Direct first-statement refusal in all four current-image observation entry functions. | General prevention of a trusted developer modifying code or invoking unrelated standalone tools. |
| Candidate file read | Bounded, descriptor-anchored reads of fixed known regular file bytes, with observed name/stamp rechecks. | Ongoing filesystem isolation, hostile kernel/procfs resistance or future loader confinement. |
| Runtime behavior | Existing finite replay/semantic tests and fixed budgets remain intact. | Tracing/replay is post-hoc detection; it does not prevent arbitrary network/filesystem effects. `prlimit` and process groups are not a sandbox. |
| Node image | Exact offline bundle/child/manifest bytes. | The child stat/hash checks occur after its static producer import has already loaded/evaluated. `createRequire` and optional external `bufferutil`/`utf-8-validate` still need reviewed loader closure. |
| Python observer | Source file inventory/hashes and independently reviewed preparation delta. | Hashing a mutable `.py` file does not attest the already imported module, interpreter, monkeypatch state or native dependencies. |
| Bootstrap association | Existing original-run receipt checks and historical physical regressions are preserved. | No original current-source closed bootstrap graph or connected capability exists. Synthetic closure is not an authority source. |

The trusted substrate includes Python/cryptography, Linux/procfs, the cooperative
same-process ownership model, compiler/dependencies and future clock/tracer/runtime
measurements. Filesystem races are tested at relevant inspection boundaries; no
claim of containment against an arbitrary hostile same-UID process or kernel is
made. A mutable on-disk image hash, even with a newly chosen source pin, is not
loaded-module identity and cannot authorize execution.

## Design for a future replacement of the refusal

Only the first stage below is implemented. All later stages remain unavailable;
there is no capability constructor or switch in this increment that can reach them.

1. **Offline preparation:** fixed-image correspondence, exact source/runtime review
   obligations and non-authoritative physical snapshots. This stage can fail closed
   without starting a worker, subprocess or tracer.
2. **Separately authorized session:** an independently authenticated controller must
   bind the approved exact source, image, interpreter/loader closure, environment,
   disposable workspace, finite lanes and original limits to one original session.
   A JSON report, success boolean, CLI/environment toggle, mutable metadata,
   descriptive inspection object, digest or synthetic closure cannot create that
   session. The approval/ownership mechanism is not implemented here and must be
   reviewed before the unconditional refusal can be replaced.
3. **Preventive containment and loaded-code binding:** establish and verify the
   actual disposable isolation boundary before importing/evaluating candidate code.
   It must exclude production data/credentials and unapproved network/filesystem
   access, constrain inherited environment and descriptors for every subprocess,
   and bind the actual interpreter and complete executed/imported module graph to
   immutable reviewed bytes. Post-import pathname checks or a child assertion do
   not satisfy this. An immutable execution image plus reviewed bootstrap/loader
   discipline is a design obligation, not an existing implementation or approval.
4. **Acquisition-scoped ownership:** register cleanup before each resource-producing
   step, starting with the first directory/FD/lock. Keep exact process ownership and
   a settlement result on all failures; disposal must refuse if cleanup is uncertain.
   Do not signal a reused PID/group, reopen another process by numeric PID, or rely
   on an assumed successfully started worker. Preserve existing finite cleanup,
   owner/run, trace, metadata and process bounds.
5. **Original bootstrap then connected lineage:** after separately authorized
   observation, only the original supervisor's permanently closed process/resource
   graph, independently authenticated correlations and retained unchanged image,
   trace, originals and receipt can establish the connected association. Preserve
   distinct lifetimes, no aliasing/replacement, original callable ownership and
   fresh checks before commands. No receipt deserializer or imported historical
   positive fixture may supply that capability.
6. **Current-source replay and semantic composition:** consume the entire original
   trace under a reviewed current-source grammar, then validate Save's zero effects,
   separate Allow Once, fresh valid authority, final original delivery ownership,
   exact timing and closed effects. A passing offline aggregate remains
   non-authoritative. Any runtime failure preserves the first refusal/evidence;
   it does not trigger retries, wider bounds or alternate launch paths.
7. **Private evidence and public summaries:** retain raw traces, tokens and protected
   evidence only in a bounded private artifact area. Publish an allowlisted reason
   code and bounded safe scalar fields; do not concatenate raw exception text.
   Root/UUID replacement alone is insufficient redaction. Evidence itself is not
   permission for activation or another run.

The historical body has concrete gaps before a future launch review: its broad
cleanup `try/finally` starts after locks, pipes, plan/probe work, provenance setup
and `worker.start()`; earlier exceptions can leave resources owned. Later cleanup
closes descriptors sequentially and can stop on a close exception. Probe/ldd work
inherits more environment than the final tracee, and checkpoints can include raw
exception text after only partial redaction. These are unreachable under the
current refusals and are documented obligations, not repaired or activated here.

## Validation and handoff

The new tests build an unlaunched genuine current image in a frozen dependency
checkout and validate its fixed positive baseline before adversarial copies.
They cover manifest/output tamper, missing/extra inventory, symlink components,
hardlinks/FIFO/writable modes, same-byte replacement, during-read file/directory
replacement, earlier-file mutation, descriptor cleanup on read/close failure,
fourth-entry enumeration refusal, special-file replacement before read-open,
unsupported-platform refusal and no-side-effect public entry guards.

The normal non-live selector includes the new module and retains the same four
real-tracer exclusions. Historical fixtures require the byte-exact current harness:
43 Python files plus the reference manifest, all disjoint from historical image
inputs. The existing seven original historical physical tests and current legacy
source/designation refusal remain mandatory, not skips or expected failures.

Initial pre-review targeted selection passed 32 methods in 0.982 seconds. The two
independent review findings above led to tighter bounded enumeration and pinned
regular-file reads plus additional tests. Final frozen validation passed **376
outer methods plus seven historical child methods in 43.803 seconds**, under the
unchanged 180-second outer bound. Independent new-module validation passed **17
methods normally (0.557 seconds) and 17 optimized (0.537 seconds)**, each under
the existing 60-second bound. Each independent selection actually built a new
disposable unlaunched image and checked the real fixed-byte positive baseline;
these were not mocked acceptance or hash-only tests of a supplied report.

All 387 declared inputs in the frozen validation checkout matched before testing.
All 195 repository image inputs, child/builder and the recorded prior source,
limit and historical receipt-control files remain unchanged. The updated observer
wrappers and new offline inspector have distinct source hashes, so the prior
observer-harness identity is not claimed for this continuation. The image outputs
remain unchanged. See [checks and log hashes](current-image-observation-checks.json)
and [independent review](current-image-observation-review.json).

The historical fixture received 43 Python harness files plus the reference JSON
only after disjointness checks; all 392 declared/protected historical inputs were
verified unchanged. No new fixture variable, skip or relaxed assertion was added.
Independent review resolved the two implementation findings and clarified that
cleanup attempts every close but cannot promise recovery from every OS failure.
No remaining blocking finding was identified within this preparation scope;
the explicit live/qualification obligations above remain open.

Before any future live decision, the handoff must name an exact environment and
containment mechanism, complete loaded-runtime identity, reviewed source/image
pins, original unchanged limits, permitted lanes/data, trusted session authorization,
cleanup/settlement behavior and private evidence policy. Those gates are currently
unmet. This preparation requires no live authorization, and grants none implicitly.
