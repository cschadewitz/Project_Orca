# Acceptance and implementation handoff

Preparation for #437 only. No runtime code, updater, signing, feed provisioning,
backup/restore, tester contact, diagnostics collection or website publication runs here.
Parent #387/#389 acceptance remains open. Re-read current source and freeze exact ownership
before implementation; do not import active MCP peer branches or change shared files now.

## Source refresh and evidence limits

Reconciled against main `c1eba301702fef0466b2d3481c36d62331ee7d48` on 7 October: protocol 2.0/
operator-journals-v4 and merged operator source; approved Mac bundle/Team identity,
retained Windows identity and inactive Mac signing. The 3 October protocol 1.10/v3
audit remains historical. This four-document refresh runs static owned-path/link/
whitespace validation only; earlier docs CI/review stays attributed to `48c6723`.
No updater engine, safe-idle, restore, signing/native or physical test is rerun/implied.

## Decisions and prerequisites

| Decision | Owner / evidence required before implementation or enablement |
| --- | --- |
| Approved experience | Casey has chosen automatic installation after approval. Implementing that requirement remains open under #387; manual replacement alone is insufficient. |
| Active work policy | Casey + runtime owner: review safe-idle waiting/defer, parked-gate classification and whether explicit interruption is ever offered. No universal resume guarantee or automatic cancellation. |
| Approval lifetime/check cadence | Casey + UX/platform: approve session binding, expiry, relaunch behavior, defer/revocation boundary and update-check privacy/frequency. Safe proposal: no unapproved staging and no restored install permission after process restart. |
| Updater engine | #387 platform owner: compare existing electron-updater MacUpdater with Electron native autoUpdater using locked versions. Prove staging/ordinary-quit/relaunch and cancellation semantics before selecting; no new dependency/framework is frozen here. |
| Trust and distribution | #385 owner + security review: personal publisher enrollment, approved secure provisioning, signed/notarized/stapled artifacts, private delivery, feed metadata/freshness, revocation and restricted writer/read authority. All actual provisioning pending. |
| Native identity upgrade | #387/#385/#388: old-to-new `com.schadewitz.orca`/Team identity, notifications/URL/OS permissions and existing `admission-intents.enc` Keychain access. Windows `dev.orca.desktop` remains unchanged. No journal deletion/keychain reset to bypass refusal. |
| Data/rollback boundary | #387 + store/runtime owners: exact store inventory, protocol/epoch/write compatibility, reliable safe-idle boundary, complete backup/matching binary, isolated restore and retained-newer-work policy. No bare epoch-equality rollback rule. |
| Recovery semantics | Runtime owner: typed known-failed versus unknown outcomes; safe recovery ownership and inability to reopen admission. Coordinate #394–396 without blocking early MCP proof. |
| Diagnostics/support | #416 and #389 owners: validated manual preview/export, safe codes, named support route and informed consent. Reuse #469 decisions 1–9 for settled product bounds; #470 implementation, actual consent and technical/privacy/native acceptance remain separate. #417/#418 remain later. |
| Test cohort/guide | #388/#390/#389: actual supported candidate/OS/chip matrix, separately consented physical session and Windows instructions/evidence. M3–M5 targets are not certification. Hub publication is separate and not authorized here. |

## Proposed code ownership, to freeze in implementation planning

The #387 app owner should own Mac update-driver integration, update contract/IPC/state
coordination and focused tests. The existing `updates.ts`, `update-driver.ts`,
`update-contract.ts`, bridge/preload and renderer update controls are coordination points,
not files allocated by this preparation. Reuse design primitives/shortcuts and all-window
draft guards. The runtime maintenance/admission owner owns any required activity/fence
projection and durable recovery semantics; no duplicate ledger or arbitrary install RPC.
The #385 delivery owner owns packaging, signing, update metadata and publisher/feed
verification. Manifest/lockfile, CI and shared protocol edits require an integrator.
The #388 harness consumes the final #402 artifact contract and #387 paired-version
recovery fixtures. #389 owns tested guide wording; #390 owns physical acceptance.

Implementation order: review decisions and engine spike with synthetic state → freeze
interfaces/ownership → implement typed adapter/guards and trust verification → signed
paired-candidate packaged tests → physical and unassisted walkthrough → separately
approved delivery/guide publication. Documentation, synthetic test design and #416
integration planning can run in parallel. Do not invert #390 into an implementation
prerequisite or claim a new dependency on current MCP completion for these documents.

## Focused verification matrix (all execution pending)

Reuse [native matrix](../native-mac-testing/test-matrix.md) and
[evidence template](../native-mac-testing/evidence-template.md); add these update rows
instead of recreating the generic Mac harness. Record exact N/N+1 artifact digests,
source/build, publisher, architecture, app/daemon/protocol/store identities, engine
versions, actual OS/hardware and each row's pass/fail/blocked/not-run outcome. Real
participant records stay in the approved private record, not these documents.

| ID | Scenario and required oracle | Evidence / owner |
| --- | --- | --- |
| U01 | Decline/defer/default, duplicate approval, changed candidate and stale/replayed approval never stage/apply unapproved code; no install on ordinary quit/relaunch after defer. | Synthetic state machine plus actual engine lifecycle; #387 |
| U02 | Approved exact candidate downloads/verifies and installs automatically at proven safe idle; startup validates identity before admission opens. No manual app replacement needed. | Signed N→N+1 installed package; #387/#388 |
| U03 | Active operation, callback, unsaved config/answer/draft, unresponsive window, unknown daemon ownership and new admission race block replacement without lost work or force kill. | Integration races + installed package; #387/runtime |
| U04 | Parked gate, completed work and preserved drafts/history retain semantics across accepted restart. External daemon untouched; wrong workspace/candidate identity rejected. | Synthetic protected-state fixtures and packaged checks; #387 |
| U05 | Offline/401/revoked feed authority, truncated/corrupt download, full disk, interruption and sleep/wake remain bounded; installed old app unaffected before activation. | Controlled test feed, fault injection, real package; #385/#387 |
| U06 | Wrong publisher, invalid signature/notary evidence, revoked/expired signing scenarios, changed bytes, hostile redirect and replayed/downgrade metadata fail according to reviewed trust policy. No secrets leak. | Security fixtures plus real macOS trust evidence; #385/#388 |
| U07 | Failed startup/hello and crash at every activation boundary produce honest recovery state; no false successful resume, reopening or duplicate provider work. | Fault-injected package with synthetic data; #387/runtime |
| U08 | Cross-epoch and same-epoch semantic incompatibility refuse unsafe rollback; complete pre-upgrade set plus matching binary restores isolated history/keys/gates. Missing/corrupt key, mixed backup and newer work handled without mutation-based repair. | Disposable paired-candidate restore evidence; #387 |
| U09 | New downloaded/quarantined signed, notarized, stapled arm64 app installs by DMG/Applications and in-app setup on actual target-like Mac; Gatekeeper/TCC intact, no contributor PATH/terminal workaround. | Physical modern M-series; #390 |
| U10 | Approved/deferred/waiting/blocked/recovery UX understandable without coaching; keyboard, VoiceOver, focus and both themes work. Actual OS/chip recorded; unsupported/untested stay explicit. | Physical unassisted test; #389/#390 |
| U11 | Startup-before-handshake and unknown admission/resume/protected state can use validated #416 preview/export/cancel, with no default capture/upload or raw fallback. | #416 privacy/producer tests and physical walkthrough; #390 consumes |
| U12 | Upgrade/reinstall/uninstall retain declared user state and credentials; old-to-new Mac bundle/signing identity preserves verified intent-journal Keychain access, notifications/URL handling and OS permissions or blocks distribution for owner-reviewed recovery. No journal/key reset or unsupported deletion. Windows retained identity/behavior tested independently. | Disposable native accounts; #387, separate Windows evidence |

No running system, real key, user store or paid provider is a fixture. Do not simulate
acceptance by disabling authentication/security, relaxing signature checks, changing epoch
markers or using source Electron instead of the downloaded package. Offline/checksum/type
proof is useful but cannot pass U02/U06/U09. Missing signed candidate/engine/exporter is
blocked, not pass. Actual observed failure stays fail even if a later retry succeeds.

## Validation for this documentation slice

Required here: source/issue review, scope audit, relative Markdown target validation,
UTF-8/LF/final newline/trailing-whitespace checks and `git diff --check` on the owned
four-file diff. Repository policy excludes Markdown from Prettier; do not report a
skipped Markdown format check as substantive validation. Record exact commands/results
and the published commit in the draft PR. No executable change means runtime suite,
typecheck/build/Electron smoke, signing, package update, restore and physical tests are
**not run**, not implied successful. Publication verification must show only these four
owned Markdown files against the prior head and unchanged original ancestry. Review outstanding
questions before implementation.
