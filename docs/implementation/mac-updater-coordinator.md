# Mac updater implementation slice 1 — candidate approval coordinator (#387)

This implements a main-process orchestration component and synthetic tests. Production
Mac updates remain **unavailable**: `updateDriver` still selects only packaged Windows.
This is a substantive first slice, not completion of #387 or native upgrade acceptance.
No existing desktop, protocol, daemon, manifest, lockfile, packaging or CI file changes.

## Exact source and contract binding

Implementation base: main `c1eba301702fef0466b2d3481c36d62331ee7d48`, verified against
remote main before editing. Dependency PR #513 was independently verified at
`fc718aefe88d64c6e9ffeeaa668fcc961ebd3342`; none of its files/ancestry are imported.
Remote main advanced to `fff65ed1ff59e06b012369ec6e2ca3c8f07426fc` during work after #514
merged. Read-back diff shows only four agent/engine/integrations/testing manifests and the
lockfile changed; there is no updater-file overlap. This branch retains its original base.
The existing base uses locked electron-updater **6.8.9** and Electron **44.4.5**;
#513's Electron 44.5.1 binary/native acceptance remains separately owned and unrun here.

Approved requirements come from #387/#437 and reviewed PR #439 at
`39d4cf75b9e46dd267ccf0ae044f29f220fe667d`, especially its immutable
[acceptance handoff](https://github.com/cschadewitz/Project_Orca/blob/39d4cf75b9e46dd267ccf0ae044f29f220fe667d/docs/preparation/beta-update-support/acceptance-handoff.md),
[update contract](https://github.com/cschadewitz/Project_Orca/blob/39d4cf75b9e46dd267ccf0ae044f29f220fe667d/docs/preparation/beta-update-support/update-contract.md),
and [recovery contract](https://github.com/cschadewitz/Project_Orca/blob/39d4cf75b9e46dd267ccf0ae044f29f220fe667d/docs/preparation/beta-update-support/recovery-support.md).
Those documents remain on their own unmerged source branch.

## Implemented behavior

[MacUpdates](../../packages/app/src/main/mac-updates.ts) is Electron-free and accepts
main-only ports. Its tests exercise the following behavior:

- Presenting/checking is never permission to download. A fresh opaque offer ID binds
  copied, frozen candidate references and the current workspace/daemon-instance/epoch.
  Replacing an offer invalidates old IDs, including same-version rebuilds.
- Candidate references point at the digest of the existing #402 manifest bytes, whose
  identity binds artifact, publisher, architecture, versions, source/build, daemon,
  protocol and store. Channel and reviewed compatibility/recovery plan identities are
  also bound to consent. This reference is not a competing artifact manifest or trust
  validator. A trusted candidate resolver is required before presenting real offers.
- Approval serializes one verified app-owned download; duplicate approvals do nothing.
  Download storage must be separate from native staging, so defer/ordinary exit cannot
  schedule Squirrel installation. Download failure is distinct from activation uncertainty.
- The coordinator acquires an all-window draft lease and then an atomic owned-daemon
  admission lease, followed by final candidate/identity/compatibility/recovery validation.
  Busy work, callbacks, drafts or missing windows wait without cancelling/replaying work.
  `reconsider()` is called on supported activity changes; it adds no polling/check cadence.
- Defer revokes permission through download/preparation, aborts the download and rejects
  late completion. Known acquired leases release in reverse order. A synchronous final
  approval/commit boundary prevents defer racing with activation; committed activation
  cannot be reversed by a late defer.
- Unknown guard acquisition, identity mismatch, validation, activation or release seals
  the coordinator in `recovery-required`. No blind resume, retry, wrong-target release or
  binary rollback is attempted. Explicit known refusal permits release only when the
  adapter proves installed binary/state untouched and the original lease still resumable.
- A committed adapter result means `awaiting-restart`, never installed-and-ready.
  Admission/draft guards remain held. Startup/reconnect must pass the recovery owner's
  expected identity checks before any admission reopening. A new process restores no
  approval; there is no permission persistence or automatic retry after an unknown result.
- Snapshots contain fixed phases/blockers and an offer ID. Raw exception text, credentials,
  target paths, protected records and feed details do not enter them.

The session-only behavior is a conservative internal proposal, not approval of final
expiry, lifetime, defer UX or check-frequency/privacy policy. Review those before wiring
this component to production IPC. The full native engine and recovery adapters are absent,
so the tests cannot establish their port guarantees simply by compiling this interface.

## Locked engine source investigation; no selection or enablement

Read the installed `electron-updater/out/MacUpdater.js` at 6.8.9. With
`autoInstallOnAppQuit = false`, `updateDownloaded` sets up its local Squirrel proxy but
resolves without calling native `checkForUpdates`. `quitAndInstall` adds a native
`update-downloaded` listener and initiates native checking; `handleUpdateDownloaded`
then calls native quit/install (or app quit). This explains why copying the Windows
adapter is insufficient. It does not prove cancellation, cache/ordinary-relaunch behavior,
repeat listener safety, signing trust, post-failure identity or native installation.
Electron's native updater alone is also not selected here.

The current Windows coordinator's recovery catch suppresses `resume` failure; it is not
suitable evidence for truthful Mac recovery. The current bundled-process `stop()` can
escalate to SIGKILL on timeout. The new Mac port explicitly prohibits forced stop during
updates; no production adapter delegates blindly to `Workspace.stopForUpdate()`.
#526 shutdown review remains separately owned, and this slice edits none of that scope.
Existing Windows behavior is preserved; its tests are regression evidence only.

## Validation and evidence boundary

Tools: per-command
`PATH=/workspace/.orca-tools/node_modules/.bin:/opt/codex/cua_node/bin:$PATH`,
Node **24.21.0**, pnpm **12.4.2**. Existing frozen dependency trust and manifests are
preserved; no dependency addition or approval-policy change.

[Tests](../../packages/app/test/mac-updates.test.ts) cover approval invalidation, duplicate
calls, defer races at each asynchronous preparation boundary, failed/unknown outcomes,
lease identity changes, release failure, malformed adapter outcomes and fresh-process
permission refusal. Real token-authenticated loopback daemon tests use the production
hello and maintenance handlers, in-memory synthetic credentials and a held synthetic
operation. They prove activity blocks fencing and post-fence calls are refused, including
an injected lost prepare response after the actual fence. Activation is an injected
synthetic result in these tests; no Mac daemon process or signed app is replaced.
The existing all-window `prepareDrafts` helper is exercised with two synthetic windows.

Local results on this slice: 39 new tests pass (35 synthetic coordinator cases and four
real authenticated maintenance cases). The app Node tests plus renderer update controls
and daemon maintenance regression run passes 347 tests across 28 files. Repository
`pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check` and `pnpm run build` pass.
Build reports the existing renderer chunk-size warning; its limit is unchanged. Focused
ESLint also passes on both new TypeScript files. The new integration fixture initially
omitted hello from its override method table; it was corrected to include the production
hello handler with one shared daemon boot identity. Initial test typing errors were fixed
in the fixture definitions. No timeout/assertion/skip budget changed. Record the final
published head and validation commands in the PR. Neither these tests nor Linux build/checks pass
U02/U06/U09/U12 or the native all-window/new-window lifecycle acceptance. No signing,
notarization, physical N→N+1, complete-state restore, Keychain/TCC, actual tester session,
manual CI dispatch, release or live update is performed.

## Next ownership and enablement gates

1. **#387 app/runtime owner:** review this orchestration interface, then implement owned
   target/admission and all-window leases using existing `prepareDrafts` and maintenance
   APIs. Bind the actual owned process, workspace/instance/epoch and hello before fencing;
   prevent connection/new-window races while leased. External/parked/wrong targets must be
   refused before any RPC or stop. Review active callback/lease and parked-gate classification;
   interrupted work/resume guarantees remain undecided. Coordinate separately with #526.
2. **#385 delivery/security owner + #387:** trusted candidate resolver and app-owned byte
   downloader using #402 identities and existing native verifier. Freeze private delivery,
   redirect/credential boundaries, support eligibility, freshness/revocation and signing
   policy. Checksums alone are insufficient. Review approval lifetime/check policy before UI.
   No new dependency or shared manifest edit without the dependency owner/integrator.
3. **#387 store/runtime/recovery owners:** candidate-specific complete quiescent protected
   state inventory, matching retained binary, durable activation journal, safe stop and
   verified startup/reconnect while admission stays closed. Include both hidden execution
   keys, encrypted execution/workflow state, config/generation/artifact/plan/operator/
   admission/revision state, credentials, app preferences/durable drafts and separate
   CLI/ACP stores where applicable. Agree backup protection/retention and newer-work handling.
   Same protocol/epoch alone never authorizes binary rollback. No state/key/journal reset.
4. **#387 native owner + #385/#388:** select/test the engine with exact signed paired arm64
   candidates. Bind approved `com.schadewitz.orca` / Team `Q2FP9UY5T4` and prove access to
   old `dev.orca.desktop` intent-journal Keychain material, notifications, `orca://` and
   TCC permissions. Unchanged paths are not continuity evidence. Windows retains its ID.
   Stage native bytes only after the safe commit boundary; prove ordinary quit/relaunch,
   defer, failures, retained guards and exact replacement. No arbitrary install RPC.
5. **#388/#390/#389:** packaged signed N→N+1, full matching-state isolated recovery,
   physical Apple Silicon and unassisted tester acceptance, with exact binaries/OS/chip
   recorded. Independent review/CI belongs to the parent after this handoff. Parent issue
   #387 stays open; no claim that Debian service cutover or Linux mocks prove upgrades.
