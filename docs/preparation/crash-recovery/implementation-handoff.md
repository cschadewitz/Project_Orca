# #469 implementation review and native handoff

The draft implements the accepted bounded recovery coordinator, encrypted Node
storage, persistent consent setting, cleanup, exact preview and explicit local
Save/Save-again flow. Production capture remains disabled. The bundled production
native adapter deliberately refuses all filesystem authority and no production
clock or diagnostic producer is connected. This is an implementation candidate
for review, not a working Mac/Windows recovery release or an activation request.

## 7 October authority corrections

The [full-head review](https://github.com/cschadewitz/Project_Orca/pull/470#issuecomment-5984828613)
of `4b7ff36345593bf314e8108e78d2b7215b69c123` identified three additional
blocking schedules. Runtime/test correction commit
`edbc852d0c0f1443fb5822e13acf2d80ce543fc6` addresses them without changing
product decisions, preparation deadlines or the disabled production boundary:

- Enable captures authority before initialization or cleanup. Main IPC also
  fences an Enable waiting for initialization when a newer verified Off arrives.
  Barrier tests complete durable Off while the older Enable still waits in
  pre-enable cleanup, and separately pause controller initialization. Both require
  durable/in-memory Off and no enabling write, ring restart, history open or key
  wrapping after the stale request resumes.
- Trusted renderer disposal advances preview authority before releasing existing
  references. Pending decrypt/preparation remains charged and busy until real
  settlement, then refuses its late valid payload. Main advances document
  generation on `render-process-gone`, covering requests waiting for initialization
  without relying on a reload. Consent and continued capture remain distinct from
  disposal. Tests cover the actual main handler and a paused genuine prior-session
  read following the Linux crash fixture.
- Every observed invalid clock sample latches uncertainty immediately, clears the
  ring and preview authority, and schedules one owned-history maintenance attempt
  through the existing mutation slot. No recursive status emission occurs. A
  plausible later sample cannot restore old history, including after a cleanup
  failure. Status and preview checks cover rollback, missing readings, changed
  boot identity and a throwing clock; another barrier holds the mutation slot and
  verifies serialized maintenance, failure visibility and explicit safe retry.

These are 14 new deterministic tests: 12 controller/Linux-filesystem tests in
`recovery-authority.test.ts` and two main IPC tests. The first 12 added regressions
were run against the unchanged reviewed source: all 12 failed at the expected
consent, late-preview or forgotten-clock assertions; the ten existing main tests
passed. The later busy-slot and renderer-initialization regressions also pass on
the correction. Synthetic keys/clocks and Linux fixture syscalls are not packaged
Mac/Windows, clock, ACL, OS-protection or physical-device acceptance.

Validation used Node **24.21.0**, pnpm **12.4.2**, the frozen lockfile and unchanged
supply-chain policies (534 entries verified). Every invocation selected the task
runtime with:

```sh
export PATH=/workspace/.orca-tools/node_modules/.bin:/opt/codex/cua_node/bin:$PATH
```

The final focused aggregate passed **203/203 across 11 files**, one worker,
34.56 seconds. Exact focused command (the umask affects this test process only):

```sh
umask 022
pnpm exec vitest run packages/app/test/recovery-authority.test.ts packages/app/test/recovery-integration.test.ts packages/app/test/recovery-storage.test.ts packages/app/test/recovery-disk.test.ts packages/app/test/report-validation.test.ts packages/app/test/pretrigger-buffer.test.ts packages/app/test/daemon-connection-integration.test.ts packages/app/renderer/test/diagnostics.test.tsx packages/app/test/recovery-preparation --maxWorkers=1
```

Workspace/renderer typechecks, targeted ESLint for all four changed code/test
files, build, full Prettier, CSS-token and generated-design checks and all 12 Python
contract fixtures pass. Vite retains the existing >500 kB warning (331 modules,
675.70 kB JS). Initial typechecking caught a new test's possibly undefined clock
reading; the test's discriminated branches were corrected before the passing run.

The first broader aggregate under the shell's **0077** umask passed 202 and failed
one unchanged storage test, `requires a valid persisted off setting before
preserving unsafe staging for cleanup`. The test requests an unsafe 0644 stage;
0077 instead creates a private 0600 file. It failed identically in isolation and
passed **21/21** with test-process umask 0022, followed by the passing full focused
aggregate above. No fixture, assertion, timeout, host umask or workflow changed.
Historical failure/performance evidence below remains intact.

Current main `d7546ce6bcaf51f194aade26de2cd9a432cd7073` has no competing changes
in these diagnostics source/test paths; `git merge-tree --write-tree` found a clean
integration. This correction stays on the existing PR branch without an unrelated
main merge. The remote head was checked before work and must be checked again
immediately before the normal fast-forward update; no competing work is overwritten.
PR metadata records the final documentation head and its exact-head CI separately.

The nonblocking preparation response deadline follow-up was deliberately deferred.
Native adapters, packaged-device/network/paired-load observations, combined 32 MiB
memory and the missed 4 ms work target remain open, as do #416/#469. No production
capture, producers, uploads, deployment, merge or acceptance claim is enabled here.
#509/#510 implementation and #511 CI monitoring remain separate and untouched.

## Decisions and ownership

Decisions [1–6](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976190374),
[7](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976357825),
[8](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976828540) and
[9](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5977241702)
are the product authority. The reconciled [integration contract](integration-contract.md)
controls implementation. Recorded product approval does not represent actual
per-user consent or Cal's acceptance of the final runtime.

The lead owns the shared IPC/storage interfaces, coordinator and integration.
Storage, UI and implementation tests were developed in separate worktrees and
adopted as isolated commits. Existing peer worktree documentation was preserved.
The rolling closed-enum ring/profile/schema was adopted from #441 at
`97097ea076044555b401d49b8e75da8cc1e42df9`, with the approved event cap raised to
8,192 and its validator/tests reconciled. Coordination is recorded on #441;
#438 `5201922e795e6e614f427d35ffba1ee8bee82337` and #455
`38a50e0c0ca4465afc4ec7f6ecaef496739756b3` were read but not imported.

## Implemented behavior

- Persistent actual opt-in, default off, current scope version, configurable
  1–15 minutes with a five-minute default. Renderer navigation revokes preview
  authority without creating or renewing consent. Opt-out revokes immediately;
  durable setting/cleanup failures remain visible.
- Three bounded authenticated ciphertext slots, session and control keys wrapped
  through a separate asynchronous diagnostics key adapter, authenticated manifest
  authority, original same-boot 24-hour anchors, clean-exit revocation and no scan
  promotion. Five-second checkpoint and maintenance timer targets; stalled work
  stays fenced rather than starting another worker.
- One frozen canonical preview with fresh public report/session IDs for recovery,
  exact UTF-8 text including final newline, five-minute nonrenewing lease clipped
  by source expiry, omissions and possible checkpoint tail loss. Renderer disposal
  releases its reserved copy only after DOM removal or trusted document disposal.
- Explicit picker and separate Save, fresh opaque destination authority, exactly
  one private plaintext staging slot, identity recorded before plaintext, same
  filesystem and atomic no-overwrite publication. No retry, automatic dispatch,
  overwrite or deletion of user exports.
- An uncertain operation stays unknown. Save again requires proven writer cessation,
  verified owned-staging cleanup and a durable acknowledgement before a fresh
  preview, picker and separate Save. Opt-out removes acknowledged summaries only
  after cleanup; unresolved obligations survive until they can safely be resolved.
- Diagnostics has no daemon/execution-key dependency. No diagnostic producers,
  upload path, arbitrary-content ingress, raw logs or crash dumps are enabled.

## Review findings addressed

A fresh read-only review of `f5b60ad237faf924fcefef6bd333ed6fb61706fe` found a
new Save inheriting a prior known outcome, missing live expiry of prior files,
and false cleanup success after an aborted checkpoint. The final candidate resets
outcome authority for every fresh operation and authenticates on-disk maintenance
before expiring prior history or removing abandoned artifacts. Regression tests
cover both saved/refused predecessors followed by admitted rejection, expiry
without preview including unresolved-export restart, and subsequent checkpoint
recovery after interrupted writes. Clock uncertainty stops capture and attempts
authenticated expiry; reused mutable clock objects cannot alter earlier anchors.
UI feedback clears at the next explicit action, and same-document exact-handle
disposal remains possible after a target switch without granting new authority.
This review does not substitute for a fresh review of the final SHA.

## PR comment follow-up

The [delivered-scope review](https://github.com/cschadewitz/Project_Orca/pull/470#issuecomment-5979140255)
reviewed `56c75a5d62ef8b4a962d3ab71d8aac2d29716f3a`. Each finding was reproduced
or traced before a separate correction. The runtime candidate after this follow-up
is `51c4f68ae7e60ae1c7fe941308a3e8801b017e8e`; PR metadata records the final
documentation head and current base. The following corrections preserve decisions
1–9, the five-minute default and the disabled production boundary.

| Review item | Correction and regression evidence |
| --- | --- |
| Timeout before native admission | `9f3dbee7ffc38f3aa8192fe5a89de8c4121a14e8` revokes the epoch, preview and destination on timeout while retaining busy work and reservations. The new test fails on the reviewed controller and prevents publication after releasing the paused admission. Already-admitted late saved/refused tests remain green. |
| Unconfirmed opt-out displayed as Off | `d00e9fa93b699a4552a6e9b3042acbd52b6b232e` removes the optimistic consent override. Local disposal is immediate; only authoritative disabled status supports session-only Off feedback. Transport rejection, stale-epoch rejection before controller invocation, later enabled status and genuine durable-off failure are tested. |
| Completed Save refusal strands previews | `f8fc8dba73559ea701c6b30a25f9b5c311e126ed` permits fresh previews after a safe completed refusal. `23f4c7234fff700cd7e99d06431c4a9c1c87eaf6` adds actual Linux no-overwrite refusal tests through close/expiry and maintenance, preserving consent, retained history, prior exports and a raced destination. UI tests require a fresh picker and separate Save. |
| Coerced report identities | `6279c050d4053662dfd0bd4e5a7ac9bd5088a2a1` requires primitive UUID strings of the exact length before regex and identity checks. Array-valued and equal identities fail before both normal and recovered fresh-ID validation. |
| Incorrect retained coverage | `40f8f268d83874207dfb13e668c12476d3e2a211` requires zero coverage for no events, otherwise observed coverage minus the first retained event offset. Empty/nonempty malformed fixtures fail both validator paths; an actual encrypted malformed prior checkpoint is rejected before refreshed recovery IDs. |

The [decision-9 owner handoff](https://github.com/cschadewitz/Project_Orca/pull/470#issuecomment-5977246655)
was also rechecked. `cabe22c2b9953cc55b9a12505891e7a388345933` reconciles the
observation oracle with authorized opt-out summary removal: durable disabled state,
independent writer-cessation/staging-cleanup evidence and no unresolved operation
must precede a committed removal. Failed removal, late callbacks, reservations and
restart non-recreation have explicit tests. `290a09cf445ff7ffbcab035465d2ea48ab6eafb4`
adds actual SIGKILL interruptions immediately before/after summary unlink and with
a newer unresolved operation; existing user exports remain unchanged.

Two related cleanup gaps found during this audit were corrected:

- `a3c67969579ec0cbbbb79a2a8eb4d42c0ea989e5` allows durable opt-out and independent
  diagnostics-key/ciphertext cleanup when the fixed staging entry is unsafe, only
  under proven writer cessation and the existing byte/entry limits. It never
  follows or removes an unsafe stage or changes user files. New capture, export
  and re-enabling remain blocked; invalid off state, missing cessation proof,
  unsafe other entries and oversized directories refuse this narrow exception.
- `51c4f68ae7e60ae1c7fe941308a3e8801b017e8e` rereads the durable export journal
  after cleanup. A failed startup read cannot leave an empty cached state that
  later bypasses acknowledgement. Newly discovered operation IDs cannot inherit
  an old known outcome. Actual crash/restart regressions exercise both cleanup
  retry and set-enabled entry points with an unsafe stage, then stage repair.

A fresh read-only reviewer found the cached-obligation bypass at
`a3c67969579ec0cbbbb79a2a8eb4d42c0ea989e5` and found no remaining finding in that
narrow fix scope at `51c4f68ae7e60ae1c7fe941308a3e8801b017e8e`. This is source
review, without a test rerun, full-head approval or native acceptance.

## Follow-up validation

At `51c4f68ae7e60ae1c7fe941308a3e8801b017e8e`, the focused aggregate passed
**189/189 tests across 10 files**, one worker, 93.02 seconds. It covers recovery
integration/storage/disk, report validation, pretrigger buffering, main IPC,
renderer lifecycle and preparation helpers/oracle (now 32 oracle tests).
The complete unrelated runtime suite was not rerun for this review follow-up.

```sh
TMPDIR=/home/casey/kepler/tasks/e3aae8ed-274c-4dbc-93b8-484849709314/test-tmp mise exec -- node node_modules/vitest/vitest.mjs run packages/app/test/recovery-integration.test.ts packages/app/test/recovery-storage.test.ts packages/app/test/recovery-disk.test.ts packages/app/test/report-validation.test.ts packages/app/test/pretrigger-buffer.test.ts packages/app/test/daemon-connection-integration.test.ts packages/app/renderer/test/diagnostics.test.tsx packages/app/test/recovery-preparation --maxWorkers=1
```

Workspace and renderer no-emit typechecks, build typecheck and Vite renderer build
pass for this follow-up (331 modules, 675.70 kB generated JS; the existing >500 kB
warning remains). Fourteen changed code paths passed unchanged ESLint config in
two bounded main/renderer groups; the final controller/test delta was rechecked.
Full Prettier, CSS-token, generated-design and 12 Python contract fixtures pass;
Markdown is excluded by repository policy. Final documentation links and diff
whitespace were checked separately.

The first follow-up aggregate at `a3c67969579ec0cbbbb79a2a8eb4d42c0ea989e5`
returned 182 passes and five failures: two storage-test 30-second timeouts and
three existing fixture actions exceeding their short operation deadlines during
shared-host load and concurrent local checks. The seven related cases passed
unchanged in an isolated rerun (8.08 seconds); the final aggregate above also
passed. No production deadline, assertion or test timeout was relaxed. Red
regressions also demonstrated the original timeout, identity, coverage, unsafe
stage cleanup and cached-obligation failures before their respective fixes.

## Evidence and limits

The following original integration evidence is historical. Its runtime freeze
was `602c97e2faf4f5b9e62fe14f5ba40d48c981f5b5`; the subsequent original handoff
commit `0d34bc4d673cfbbe5fcbc10e5426f5603931ae26` changed documentation only.
The review follow-up above changes runtime behavior. Numerical evidence in
[workload-linux.json](workload-linux.json) remains attributed to the original
`602c97e2faf4f5b9e62fe14f5ba40d48c981f5b5` probe; it was not rerun or relabeled.

Actual checks:

| Check | Exact code and outcome |
| --- | --- |
| Complete Vitest scope | `e623e703da63ad28335c3e810977c5ce8876ca14`: 4,008 passed / 3 skipped with `--maxWorkers=2`, excluding the two path-sensitive files; those passed separately 23/23 with `--maxWorkers=1`. Combined 4,031 passed / 3 skipped across 322 files. 801.92s for the large run. |
| Final diagnostics delta | `0ca3f67925578896ab70ba8ef11a1ff654b169ac`: 97/97 across real recovery integration 34, storage 36, main IPC 10 and UI 17, one worker. Final cleanup-only follow-up at runtime freeze: integration 34/34 rerun. Entire unrelated runtime suite not rerun after these focused consent/outcome changes. |
| TypeScript/build | Workspace + renderer no-emit typechecks pass; final runtime `tsc -b tsconfig.build.json` and Vite renderer build pass (331 modules). Existing >500 kB chunk warning remains; generated JS is 675.62 kB. |
| Lint | All 819 tracked code paths checked with unchanged repository ESLint config in 17 project-separated batches, <=50 paths/process and 1536 MiB heap. Final changed files rechecked after later edits. Single-process attempts exited 137 (killed) and 134 (heap exhaustion); first batched attempt found a test cast, corrected and rerun. |
| Schema/format/design | 12 Python closed-contract fixtures pass. Full Prettier, CSS-token and generated-design checks pass; final handoff links and diff checks pass. Markdown is intentionally excluded from Prettier. |

Actual commands (from repository root; replace these task-owned temporary paths with private disposable directories for a new run):

```sh
TMPDIR=/home/casey/kepler/tasks/e3aae8ed-274c-4dbc-93b8-484849709314/test-tmp mise exec -- node node_modules/vitest/vitest.mjs run --maxWorkers=2 --exclude tools/test/private-mcp-service.test.js --exclude packages/integrations/test/kepler-workspace.test.ts
TMPDIR=/dev/shm/orca469-policy-tests-JO7L4R mise exec -- node node_modules/vitest/vitest.mjs run tools/test/private-mcp-service.test.js packages/integrations/test/kepler-workspace.test.ts --maxWorkers=1
TMPDIR=/home/casey/kepler/tasks/e3aae8ed-274c-4dbc-93b8-484849709314/test-tmp mise exec -- node node_modules/vitest/vitest.mjs run packages/app/test/recovery-integration.test.ts packages/app/test/recovery-storage.test.ts packages/app/test/recovery-disk.test.ts packages/app/test/daemon-connection-integration.test.ts packages/app/renderer/test/diagnostics.test.tsx --maxWorkers=1
mise exec -- node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
mise exec -- node node_modules/typescript/bin/tsc -p packages/app/renderer/tsconfig.json --noEmit
mise exec -- node node_modules/typescript/bin/tsc -b tsconfig.build.json
mise exec -- node packages/app/node_modules/vite/bin/vite.js build --config packages/app/vite.config.ts
python3 docs/preparation/manual-diagnostics-contract/test_contract.py
mise exec -- node node_modules/prettier/bin/prettier.cjs --check .
mise exec -- node tools/eslint-config/bin/check-css-tokens.js packages/app/renderer packages/design/css/components.css
mise exec -- node packages/design/build-tokens.js --check
```

The 819 lint paths come from `git ls-files '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'`, separated into renderer, other TypeScript and JavaScript groups, then batches of 50 passed to `mise exec -- node --max-old-space-size=1536 node_modules/eslint/bin/eslint.js --no-warn-ignored ...`. No rule/config changes. Recheck final changed paths after the batch run.

An earlier changing-tree aggregate returned 13 failures/3,987 passes: four missing-maintenance-method failures, one incomplete window mock, one UI synchronization failure, five unsafe temporary-ancestor refusals and two Kepler task-path assumptions. These were corrected/reexecuted; the passing frozen run above supersedes that attempt. A separate `/tmp` retry hit ENOSPC and sandbox EPERM; path-sensitive suites passed in task-owned private `/dev/shm` profiles. No unrelated temporary data was deleted.

The final numerical probe offered/retained 8192 events with 0 budget omissions: report 974,807 bytes, controlled reservations 5,242,880 bytes, retained owned disk 2,927,141 bytes and staging 974,807 bytes. Sampled main heap+external increment 24,353,099 bytes; RSS increment 36,548,608 bytes. Checkpoint 252.51 ms, peak event-loop delay 79.16 ms. The 4 ms work-chunk target is not met and combined Electron memory remains unmeasured; do not interpret the main sample as final 32 MiB acceptance.

A fresh read-only fix review found no remaining findings in its requested scope at `e623e703da63ad28335c3e810977c5ce8876ca14`. Later targeted changes make opt-out bypass initialization, preserve configured minutes under a coalesced durable-off guard, synchronously fence storage, and retain confirmed Save results through timeout/opt-out cleanup. Those have actual focused tests above; a fresh full review of the final PR head remains required.

The tests use disposable
Linux filesystem profiles, actual SIGKILL subprocess interruptions and an actual
Linux `renameat2(RENAME_NOREPLACE)` helper. Protected keys, clocks and selected
failures are synthetic/injected. The helper is compiled with
`cc -std=c11 -O2 -Wall -Wextra -Werror` and workers are bounded.

The seven previous real-adapter TODO families now have executable implementation
tests. The observation oracle remains a separate test-only model; it is not
native acceptance. Negative attempts, environment failures and timing/resource
limits must remain disclosed with the passing results.

## Required follow-up before activation

1. Review the final frozen SHA independently against the contract, privacy scope,
   consent/dispatch ordering, cleanup metadata retention, exact bytes and producer
   inventory. Confirm fixed-slot plaintext exposure and same-filesystem limitation
   in final UI copy with Casey and Cal. Do not activate on product decisions alone.
2. Implement and review real macOS and Windows adapters: stable boot identity and
   sleep-aware monotonic age; handle-relative owner-only creation, verified ACLs,
   symlink/junction/reparse and parent replacement safety; process-wide writer
   cessation; native flush, identity and atomic no-replace publication. The current
   Linux fixture does not establish these guarantees. Node checkpoint/control
   path operations also need native handle-relative binding against parent swaps.
3. Verify asynchronous Keychain/DPAPI behavior in packaged signed Electron builds,
   unavailable/missing/rotated keys, lock state and diagnostics-only revocation.
   Provider rotation currently refuses recovery; it does not silently rewrap.
4. Measure the complete main+renderer managed/external incremental memory under
   the 32 MiB review gate, the 8 MiB controlled payload reservations, all disk/entry
   limits, responsiveness and checkpoint tail under paired execution load. The
   probe samples one Node process; it is neither an allocator proof nor a combined
   Electron/native-memory measurement. Synchronous bounded JSON/crypto work still
   needs responsiveness work and native acceptance.
5. Run packaged macOS and Windows crash/restart, late writer, opt-out, cleanup,
   exact preview/export, keyboard/accessibility, network observation and execution
   independence passes. Record OS/device/signing/build/SHA and actual outcomes.
   Run the physical Apple Silicon pass with its acceptance owner separately.

#469 is registered as a native sub-issue of open #416. Do not close #416, convert
synthetic tests to physical acceptance, or enable capture/deploy/live testers in
this handoff. Power-loss durability is not promised.
