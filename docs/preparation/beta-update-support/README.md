# Beta update, recovery and support preparation

Design-only handoff for [#437](https://github.com/cschadewitz/Project_Orca/issues/437),
under [#387](https://github.com/cschadewitz/Project_Orca/issues/387), with draft guide
material for [#389](https://github.com/cschadewitz/Project_Orca/issues/389).
Original audit: 2026-10-03 main `e8678ebaa06f4deb883143df288275300f762b3e`.
Current source refresh: 7 October main `c1eba301702fef0466b2d3481c36d62331ee7d48`. No
implementation, release, Hub publication,
installation, backup/restore, provisioning or collection is performed by these documents.

## Product requirement versus current behavior

The approved experience is **automatic installation after approval of the update**,
protecting active work and unsaved drafts. Manual application replacement alone does
not satisfy that requirement; it can only be an explicitly agreed fallback/recovery
path. Approval is not a standing unattended-install permission. The exact safe-idle,
interruption and approval-lifetime proposals below still need review.

The initial qualitative cohort is two semi-technical Mac coworkers with M3–M5 targets
and up-to-date but as-yet unrecorded macOS versions, plus two technical Windows
developers. No support floor, precise OS, hardware coverage or platform certification
is inferred. The Mac path must be normal DMG → Applications → in-app setup without
Terminal or a security workaround. Casey is the intended personal Apple publisher;
Apple Developer enrollment remains pending. No certificate, provisioning or signing
permission is implied.

## Four owned documents

- [Update contract](update-contract.md): proposed states, trust, interfaces and UX.
- [Recovery and support](recovery-support.md): safe inspection, preservation and stop rules.
- [Acceptance and handoff](acceptance-handoff.md): owners, decisions and test oracles.
- This source/status index. Only these four owned Markdown files are changed by this reconciliation.

## Historical source audit and evidence boundary (3 October)

| Source on the audited main | Established fact and limit |
| --- | --- |
| [update-driver.ts](../../../packages/app/src/main/update-driver.ts) | Driver exists only for packaged win32 x64/arm64, uses `electron-updater.NsisUpdater`, disables automatic download/quit installation and disallows downgrade/prerelease. It does not implement Mac updating. |
| [updates.ts](../../../packages/app/src/main/updates.ts) | Explicit check/download/restart state machine; draft, daemon prepare/stop and resume guards. A generic recovery catch is not proof every resume succeeded. |
| [UPDATING.md](../../UPDATING.md) | Windows app and Debian managed deployment are separate. Existing activity/admission and recovery principles are reusable; the Debian pointer journal is not an installed Mac recovery engine. |
| [release-compatibility.json](../../../release-compatibility.json) | The original `e8678eb` audit declares protocol 1.10 and `config-generations-v3`. Equal epochs alone do not prove rollback compatibility: generation snapshot semantics already have a one-way compatibility caveat. |
| [protected execution storage](../../protected-execution-storage.md) | Private execution/workflow ciphertext, distinct hidden keys and public events form a coherent backup unit; missing/corrupt material fails closed. |
| [delivery contract](../native-mac-delivery/artifact-contract.md) and [test handoff](../native-mac-testing/implementation-handoff.md) | Completed preparation inputs, not signed/notarized packaged or physical acceptance. Preserve their identity/verification contracts rather than replacing the validator. |
| [first-job acceptance](../beta-first-job/acceptance.md) and [feedback guide](../beta-feedback/tester-guide.md) | Reuse the bounded coding fixture, optional safe report and separate physical/real-agent evidence. Offline fixture success is not an updater test. |
| [manual diagnostic contract](../manual-diagnostics-contract/README.md) | Merged design/fixtures at that audit, not a shipped exporter or then-approved privacy budget. #416 is required before beta; #417/#418 are later work. |

## Current compatibility and identity (7 October)

At main `c1eba301702fef0466b2d3481c36d62331ee7d48`, [release compatibility](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/release-compatibility.json)
declares **protocol 2.0 / `operator-journals-v4`**. #434 and #415 are merged;
the separate-operator-branch language above is a historical audit only. Managed
activation/recovery enforces the marker, not every direct CLI/daemon startup.
Equal epochs alone still do not establish rollback compatibility: startup/migration
and generation writes must be candidate-bound. Retain a complete consistent
pre-upgrade state set with its matching binary before any supported restore.

The current [update driver](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/app/src/main/update-driver.ts)
remains packaged Windows x64/arm64 NSIS only, with auto-download/install-on-quit
disabled. **Mac automatic updating is still an implementation/acceptance gap.**
Automatic installation after approval of a specific update is already settled;
safe idle/defer, approval lifetime/check cadence, actual engine staging/quit/relaunch,
trust/freshness, recovery, signing and physical acceptance remain genuine review gates.

Current [builder identity](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/app/electron-builder.yml) and
[release identity/upgrade contract](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/docs/RELEASING.md) record approved
Mac/default bundle ID **`com.schadewitz.orca`** and Apple Team **`Q2FP9UY5T4`**.
Windows explicitly retains **`dev.orca.desktop`** for NSIS/AppUserModelID continuity.
Mac `identity: null` / `notarize: false` remain: this is not certificate enrollment,
signing/notary or native acceptance. App-name/userData/path continuity is not
Keychain continuity. Before old-to-new Mac distribution, verify notifications,
`orca://`, OS permissions and decrypt/verify of `admission-intents.enc` through the
existing Keychain under the new signed identity. Do not delete the journal/reset
Keychain to bypass refusal; unresolved continuity is an upgrade/recovery-owner gate.

#469 decisions 1–9 settle local diagnostics product bounds (persistent default-off
opt-in, 8,192 events and bounded encrypted same-boot recovery). #470 at
`a174e33c307ef9348412eaad69bc0df9399ad684` remains disabled, with native/producers/clock and
technical/privacy/
physical gates open; its Node 22 failure/current-base validation are separate.
Do not reopen those product choices or call this a shipped exporter. #387/#389/#390
and #437 remain acceptance owners; this docs refresh clears none of their runtime gates.

#394–396 own supported restart/recovery work after usable Cal and before full operator
release. This preparation neither implements that work nor makes it a new prerequisite
for early MCP proof. MCP remains the top-priority parallel track.

## Historical platform guidance (checked 3 October)

These links record the 3 October review, not a fresh platform/API certification.
Reconcile primary guidance against exact locked dependency versions before coding.

- [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater): macOS
  uses Squirrel.Mac and requires signing; checking can download automatically, and
  staged updates can apply on later launch. Its window-closing lifecycle needs explicit
  integration with ORCA's guards. Do not assume a late restart prompt prevents staging.
- [electron-builder v26 updates](https://www.electron.build/v26/docs/features/auto-update/):
  the existing dependency family offers Mac updating; its macOS update route requires
  ZIP alongside DMG and metadata. The private GitHub-token option is not our approved
  binary-delivery design. A reviewed MacUpdater adapter is a candidate, not a selection.
- [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
  and [distribution packaging](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution):
  Developer ID/notarization and stapling belong to the delivery evidence. A successful
  packaging job alone does not prove the downloaded candidate passes Gatekeeper.

No updater framework, feed service, credential scheme or new signing capability is
chosen here. No built-in telemetry is introduced or assumed. Runtime/OS network traffic
and update-feed access metadata need their own disclosure; diagnostic consent cannot
stand in for download authorization or service/privacy review.
