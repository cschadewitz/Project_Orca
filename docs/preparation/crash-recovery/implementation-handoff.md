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

Exact candidate SHAs, executed commands/counts and numerical workload measurements
are recorded in the PR and accompanying workload artifact. The tests use disposable
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
