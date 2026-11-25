# Mac candidate binding and owned download slice (#387)

This slice depends on #536 at `a53cb4dda168399f700ea586257533504fb0e097`.
It adds three main-process modules with no production import or constructor call:
`mac-candidate-manifest.ts`, `mac-candidate-download.ts`, and
`mac-update-candidates.ts`. Production Mac offers, approval IPC, feed access, native
staging, installation, restart/reconnect, and recovery remain disabled. There is
no new dependency, package/lockfile edit, credential, signing invocation, or
change to existing daemon/desktop files.

The accepted source is [#439 at its reviewed exact head](https://github.com/cschadewitz/Project_Orca/blob/39d4cf75b9e46dd267ccf0ae044f29f220fe667d/docs/preparation/beta-update-support/acceptance-handoff.md),
including its linked update/recovery contracts. Candidate-specific owner approval
followed by automatic installation is settled; the approved Apple bundle ID and
Team are `com.schadewitz.orca` and `Q2FP9UY5T4`. This slice does not change those
choices or the safe-idle/draft/admission contracts.

## Binding and verification

The consumer reads the existing #402 `delivery-v1` artifact manifest; it does not
introduce a second manifest or modify the fixture validator. JSON parsing rejects
oversized/deep input, invalid UTF-8/BOM, duplicate (including escaped-equivalent)
keys, permissive constants and noninteger numeric spellings. Strict field/type,
identity, path, artifact/evidence, declaration, and raw sealed-identity checks
reuse the existing fixture contract. Plist version strings stay opaque: D5 is
still unresolved. Metadata bounds restrict this consumer; they are not release
version, freshness, or approval-expiry policy.

`MacCandidateSession.offer` snapshots the original bytes, main-selected channel,
compatibility/recovery plan references, delivery source and managed-daemon target
before awaiting trust. It refuses fixtures, wrong declared Team/bundle/architecture,
missing policy and invalid metadata. An existing offer cannot have its source or
plans replaced behind approval. Each later offer gets a new process-local offer
ID; neither that ID nor approval is restored after relaunch. Version equality does
not equate different builds or manifest bytes. Replay eligibility itself belongs
to the required catalog port, rather than an invented local history window.

Both trusted ports are required before any offer can be used:

- The **catalog port** must resolve exact candidate provenance, publisher/support,
  authenticated invitation, trust root, freshness/replay and revocation under the
  approved policy. It is called at offer time and before/after download. There is
  no default implementation or permissive fallback.
- The **native inspection port** must inspect the actual downloaded final DMG and
  ZIP, verify Apple signatures, Team/certificate policy, notarization/tickets and
  the extracted sealed identities plus actual bundled daemon hashes in both.
  Its read-only result must bind the manifest digest and both container proofs.
  Manifest `passed`/`Accepted` declarations and SHA256SUMS do not satisfy it.

The download helper independently snapshots/parses exact manifest bytes, rather
than trusting mutable records supplied beside them. It takes an explicitly
configured private app-owned root, byte/deadline limits and injected transport.
It never creates or changes the root's permissions. The root must be canonical,
unlinked, privately permissioned and owned by this process's user; no concurrent
external writer may mutate that trusted root. A fresh private temporary directory
owns all writes, with exclusive private files. No installed app or protected
state is read, removed, reset or changed by this helper.

The transport contract requests manual redirects, omitted ambient credentials
and no caching. HTTPS source URLs cannot contain credentials, query or fragment;
paths are escaped per component. Non-200 responses, redirects and changed
response origins/paths fail without follow-up. Private delivery authentication
still needs an approved main-owned transport; this is not a selected hosting or
access policy. File/aggregate/metadata bounds, exact sizes and streaming SHA-256,
and complete sorted SHA256SUMS coverage are checked before inspection. UTF-8
sorting preserves the Python validator's Unicode scalar ordering.

Cancellation/deadline abandon catalog/transport/body/inspection waits, prevent
late callbacks from publishing ownership or scheduling file writes, and cancel
late response bodies. Every filesystem write and file close is awaited before
cleanup/results. A hung filesystem cannot be reported as safely settled by a
wall-clock timer. These operation bounds are not update-check cadence or consent
expiry. The injected trust ports are read-only, honor abort, and cannot schedule
unresolved mutations after their result.

Verified bytes stay in the session's private owned directory. Defer discards only
that directory, clears the verified status, and retires its approval entrypoint.
A fresh offer must re-resolve bounded catalog trust; approving its fresh ID then
downloads and natively inspects newly owned bytes. A disposed offer cannot reuse
the coordinator's verified cache or silently authorize another ID. This internal
nonce rule does not choose a production expiry/relaunch/revocation policy.
Interrupted downloads await cleanup. Known
refusal/failure and unknown trust/cleanup have separate results. Unknown download
verification or cleanup seals the session against another offer/approval, even
though the coordinator's `failed` phase correctly proves that installed app and
protected state were untouched. `verification` reports that distinction without
URLs, credentials, native errors or raw metadata. A verified download stops at an
always-blocked draft adapter; no draft lease, daemon fence or activation is acquired
by this slice. The accepted draft and owned-admission adapters are not yet wired.

Native-port responses are strictly parsed before proof comparison. Missing or
unrecognized outcomes, incomplete/malformed proof shapes and throwing result reads
are unknown trust and seal this session even after known download cleanup. A valid
explicit refusal or a fully parsed proof with mismatching manifest, identity,
container or daemon binding remains a known negative.

## Native engine evidence and remaining decisions

The locally locked electron-updater 6.8.9 `MacUpdater.js` creates a Squirrel proxy
and calls native `setFeedURL` during download preparation even when
`autoInstallOnAppQuit` is false. With that flag false it postpones native
`checkForUpdates` until `quitAndInstall`; this source reading does not prove
ordinary-exit, cache/relaunch, cancellation or recovery lifecycle safety. The
helper therefore calls neither Electron's native updater nor electron-updater.
No engine has been selected, and no live candidate has been downloaded.

The dependency owner's [#513 at `fc718ae`](https://github.com/cschadewitz/Project_Orca/pull/513)
uses Electron 44.5.1 in the separate #514 → #517 → #513 stack. Its reviewed source
changes leave real Electron/native/packaging checks unrun/blocked. This branch
retains its existing locked Electron 44.4.5 source and does not rebase or edit that
owner's stack. Source audits and local Node fixtures do not supply signed Mac
acceptance evidence.

Before production offers or approval IPC, Casey/UX and the security/delivery
owners still need the already-recorded approval expiry/relaunch/revocation and
check-cadence/privacy decisions, catalog trust/freshness/replay/certificate policy,
and actual authenticated private delivery. D4 OS floor/matrix and D5 production
version/channel/plist/rebuild mapping remain candidate prerequisites. Bundle/Team
identity and approval-to-automatic-installation do not need another decision.

Restart/reconnect and full protected-state plus matching-binary recovery require
later implementation and the existing recovery-owner decisions (backup destination,
access/encryption/retention/deletion, credential restoration and newer-work policy).
Binary-only rollback is unsafe. All-writer quiescence and old
`dev.orca.desktop` → `com.schadewitz.orca` Keychain, encrypted intent journal and TCC
continuity are still gates. No deletion/reset shortcut is provided.

## Validation boundary

New tests read the unchanged #402 fixture/identity/daemon bytes. Positive download
and consent tests use clearly synthetic candidate-shaped metadata and fake catalog,
transport and native-inspection ports in disposable private directories. These
ports never establish provenance or native signature trust. Negative cases cover
metadata substitution/malformed input, fixture rejection, process-local replay,
same-version rebuilds, immutable source/plans, duplicate approval, defer/late
responses, redirect/response target refusal, interrupted/stalled streams, bounds,
checksum inventory and per-container identity/daemon proof mismatches, catalog
revocation, disposed-offer reapproval, malformed native results and unknown trust.
Existing coordinator and native-contract fixture
suites provide regression checks.

Physical signed Apple Silicon N → N+1, ordinary-exit/relaunch behavior, real native
binaries and packaging, Keychain/TCC continuity, complete-state recovery, and
unassisted invited-tester acceptance **are unrun** (#390/#388). Parent owns
independent exact-head review and CI; no CI dispatch or polling is part of this slice.
