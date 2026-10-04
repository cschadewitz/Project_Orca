# #469 implementation review and native handoff

The draft implements the accepted bounded recovery coordinator, encrypted Node
storage, persistent consent setting, cleanup, exact preview and explicit local
Save/Save-again flow. Production capture remains disabled. The bundled production
native adapter deliberately refuses all filesystem authority and no production
clock or diagnostic producer is connected. This is an implementation candidate
for review, not a working Mac/Windows recovery release or an activation request.

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

## Evidence and limits

Runtime freeze: `602c97e2faf4f5b9e62fe14f5ba40d48c981f5b5`. Later handoff/measurement commits change documentation only. PR #470 records its final head and base. Numerical evidence is in [workload-linux.json](workload-linux.json).

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
