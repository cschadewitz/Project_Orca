# M10 stale continuation reservation correction

Source base: #584 exact head `6fcd543a368246c2156f86a225072a871c754435`.
The correction is a direct descendant, preserving that head and all constituent
ancestry. Its draft targets `calcifer/m10-m21-m22-same-boot-config-integration`,
the existing #584 head branch. The main-target/merge/combined-CI hold remains.

## Defect and exact-head reproduction

The reported live connector returned `CONTINUATION_STALE` for fresh intent against
an already-completed Revision run. Independent host inspection found a bound retry
operation and reserved continuation ID, with no attachment or execution. This live
observation is supplied evidence; this change does not reinspect or mutate agent-01.

On the pinned source, `RegisteredRetryClaims.execute` published a fresh claim before
`ContinuationAdmissionService.commit` bound its continuation ID. Only afterwards
did the daemon commit acquire run ownership and validate the terminal boundary.
That violates `ContinuationJournal.commit`'s stale-boundary no-effects contract:
the run journal stayed unchanged, but the retry catalog/quota and sealed binding
had already changed. An error response alone was an insufficient no-effects oracle.

Four focused regressions were run with both production continuation source files
restored from the exact base and the added test fixtures retained. All four failed
as expected (53 unrelated cases excluded by name). Independent sealed-operation
reads showed one extra `phase: bound` operation with a new `ct_…` identity in both
keyed and unkeyed runtime cases. Authenticated HTTP and socket Revision cases
returned `CONTINUATION_STALE` but increased catalog total and both quota counters
from 1 to 2. Patched source files were restored after this reproduction.

Reproduce the narrow selection against the original source with:

```sh
node node_modules/vitest/vitest.mjs run \
  packages/daemon/test/continuation-admission-runtime.test.ts \
  packages/daemon/test/continuation-admission-transport.test.ts \
  -t 'rejects fresh .* terminal intent|operator rejects terminal Revision' \
  --maxWorkers=1
```

Use the added tests with the two production source files from the base in an
isolated checkout; running that command on the patched source should pass.

## Transaction review and correction

- The continuation operation uses the existing trusted `validateFresh` hook. The
  catalog invokes it only after a lookup miss and before claim/lookup/quota writes.
- The first lookup can resolve retained claims without run ownership. A fresh miss
  raises a private, identity-checked fence request before boundary reads or binding.
  Only after the catalog mutex has unwound does the adapter acquire run ownership.
  It then reruns the same sealed canonical intent under that ownership context.
- Lock order for fresh intent is run ownership, catalog mutex, operation mutex,
  locator/journal publication. Commit reuses the already-held run fence. Validation
  never acquires a run fence inside the catalog mutex; its boundary/token/decision
  checks are shared with commit and run before allocation. Token validation reads
  existing boundary authority and refuses a missing key without replacing it.
- Ownership spans validation through durable acceptance and retry result storage.
  Final commit still rechecks authority and the boundary, and append retains its
  sequence CAS and exact correlation. Coordinating writers use the existing fence;
  this is not a claim of isolation from arbitrary direct filesystem writers.
- Retained claims skip fresh boundary validation. Original owner/workspace/current
  grants, exact intent comparison, authoritative marker synchronization, original
  receipt semantics and bound-ID recovery remain. If another same-key caller wins
  while ownership is awaited, a pre-entry ownership refusal retries the existing
  lookup. A second fresh miss retains the original ownership refusal. Errors after
  entry do not restart the transaction or delete ambiguous evidence.
- Existing unbound ambiguity and historical bound stale operations are untouched.
  Append-before-ack still recovers the original correlation and identity; a crash
  before append retains its bound identity. Attachment, execution authority lifetime,
  single execution and terminal settlement remain separate existing boundaries.

The retry store's established first-use lookup-salt/lock metadata behavior is
unchanged. Rejection publishes no new operation, keyed intent pointer, quota charge,
continuation locator, protected decision/continuation event, attachment or execution.
The terminal fixtures already have issued boundary authority and initialized retry
metadata; their entire retry, protected execution and run-journal snapshots remain
byte-for-byte identical across repeated fresh refusals and retained-key replay.

## Focused validation

Run only the three affected suites:

```sh
node node_modules/vitest/vitest.mjs run \
  packages/engine/test/continuation-admission.test.ts \
  packages/daemon/test/continuation-admission-runtime.test.ts \
  packages/daemon/test/continuation-admission-transport.test.ts \
  --maxWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/eslint/bin/eslint.js \
  packages/engine/src/continuation-admission.ts \
  packages/daemon/src/continuation-admission.ts \
  packages/engine/test/continuation-admission.test.ts \
  packages/daemon/test/continuation-admission-runtime.test.ts \
  packages/daemon/test/continuation-admission-transport.test.ts
git diff --check
```

Final result: 83 distinct passes in those three files (23 engine service, 40 daemon
runtime, 20 authenticated transport). Ten new cases cover keyed/unkeyed terminal
intent, boundary movement while acquiring ownership, same-key and different-key
contenders, missing token-key authority, and HTTP/socket Revision terminal and
revision-action refusals. Existing invalid-token/request/option/no-answer coverage
now also proves rejected keys remain usable. Existing successful replay, key
conflicts, marker rewind/mismatch, current grants, lost acknowledgement, retained
bound IDs, restart discovery, competing attachment and settlement evidence passes.

Root TypeScript, scoped ESLint/Prettier and whitespace checks pass. Renderer code
is unchanged. Node 24.19.0 and installed Vitest 5.0.2 were used. The preinstalled
workspace lacked the app's declared `yaml@2.9.1` link; a local ignored symlink to
the already-installed core copy supplied it without an install or lockfile change.
The pnpm wrapper attempted setup and failed before installation, so direct installed
tool entrypoints were used. No broad suite, coverage, build, native/provider acceptance
or workflow run is claimed. Repeated invocations are not added to the distinct count.

## Host-owned live retest recipe

After an independently authorized host builds/loads the exact candidate, use a
dedicated synthetic Revision workflow/run and its own current authorized credential.
Do not use agent-01 or repair/delete any historical retry or continuation records.

1. Retain the issued boundary, exact non-revision decision and original successful
   continuation key. Complete that run once and wait for its settled continuation.
2. Independently snapshot the host's retry catalog/quota, sealed retry records and
   binding/lookup/locator generations, protected run journal and execution/attachment
   counts. Record safe summaries or hashes; keep keys, commands and notes private.
3. Reconnect/discover the same workspace target and call connector `continue_run`
   with the saved command and a genuinely fresh key. Require `CONTINUATION_STALE`.
   Repeat with that rejected key. Verify the independent host snapshots are unchanged:
   no new operation or continuation ID, no locator/marker/answer/attachment/execution.
   The lower-level `runs.continue` unkeyed path should give the same stale/no-effects
   result; the operator connector contract requires a key.
4. Replay the original successful key with the original command. Require the original
   operation and continuation IDs and replay flag, with no second execution or decision.
5. Keep the earlier defective reservation as historical evidence. Report exact candidate
   commit, workspace/run and safe before/after observations through the host's approved
   evidence channel. This source test does not constitute live MCP/native acceptance.

No workflow dispatch, main-target PR, merge, deployment, credential operation or
historical-evidence cleanup is part of this correction.
