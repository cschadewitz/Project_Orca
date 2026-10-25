# Bounded native Mac acceptance handoff

## Current reconciliation — 25 October 2026

Audited main: `0f45181c52dfc4bf1edd0e4469ff688dedef9189`. The integrated
[#607](https://github.com/cschadewitz/Project_Orca/pull/607) source is implemented,
not a physical-Mac acceptance receipt. Core configuration/launch
[#333](https://github.com/cschadewitz/Project_Orca/issues/333)/
[#334](https://github.com/cschadewitz/Project_Orca/issues/334) and generic actual-Cal
[#393](https://github.com/cschadewitz/Project_Orca/issues/393) are closed. Mounted
setup/launch, reviewed saved-configuration binding, same-boot ownership reconciliation,
native candidate identity/containment validation and diagnostics producers are present.
Reuse [first-run recovery](../../implementation/first-run-same-boot-recovery.md),
[delivery adapters](../native-mac-delivery/production-adapters.md),
[held composition](../../implementation/app-held-nonmac-verification.md) and
[native provider bindings](../../implementation/mac-native-provider-composition.md).
Their source/fixture and Windows receipts do not prove installed Darwin behavior.

[#389](https://github.com/cschadewitz/Project_Orca/issues/389) owns the pre-Mac
versioned guide and existing-Hub content/link readiness; candidate-specific tested
wording and unassisted proof belong to
[#390](https://github.com/cschadewitz/Project_Orca/issues/390). Preparation can
complete independently of that later acceptance. No native gate passes here.
Production diagnostics capture and updater activation remain held. Diagnostics are
**Save/export-only**; in-app report viewing/text selection was removed by the owner,
not tested successfully. JEV is excluded from supported beta setup and workflows.

[#594](https://github.com/cschadewitz/Project_Orca/issues/594) remains mandatory
before Mac beta: supported provider contract, bounded exact-command authority,
installed correspondence and separately scoped actual-Cal proof. The
[13 October scope transfer](https://github.com/cschadewitz/Project_Orca/issues/594#issuecomment-6150016812)
also places live permission-callback lifetime there: seven live identity fields,
one delivery, duplicate/wrong-field/owner-death/restart refusal. Closed #393's durable
gate evidence does not pass this row. Cal coordinates implementation; Casey retains
additional product choices; the supported provider-contract implementer/version is
still unresolved. #597/#598/#600/#601 retain their separate deferrals, with no new
Mac requirements added here.

## Historical preparation observations — 9 October 2026

The following pins describe the original preparation, not current missing code.
Current handoffs and the receipt below supersede its merge-pending and missing-adapter
statements; command vectors remain unexecuted. Dated observations are retained.

The later [native delivery source adapters](../native-mac-delivery/production-adapters.md)
implement pre-signing identity, an explicit trusted candidate validator and bounded
native containment. The pinned preparation observations below describe #573's state;
its packet still executes no command. Native/physical acceptance and explicit owner
version/OS/provenance/publisher/private-route decisions remain open.

Preparation for #385/#388/#389/#390. No Mac, signing, delivery, provider, Hub or
physical operation ran. The source packet stacks on #555
`6aac5ace722dd3c3ebc7f156f22efb73b923efdb`. UI/ownership observations use #567
`9ac19ead4347180e44be6162a41d2d5726b3f929` and #569
`1a2e003e04beaa2e13cd35115faa6c4234145264`. These are separate, unmerged sources;
this branch imports neither runtime head. Root must select a coherent immutable
integration source including the recovery owner's #570 result before acceptance.
Main remains the locally supplied `db579fb7ac9cfce2e4e6901713088a80602311da`;
no main refresh, broad regression run or workflow dispatch was needed for this slice.

## Current owner handoffs

Existing decisions already fix bundle `com.schadewitz.orca` and Team `Q2FP9UY5T4`.
No replacement policy is requested. The following are outstanding evidence/selection
inputs under [#385](https://github.com/cschadewitz/Project_Orca/issues/385).

| Owner | Required non-secret output | Remaining gate |
| --- | --- | --- |
| Casey / existing Apple custodian | Confirm existing Developer ID certificate/private-key usability, public fingerprint/expiry, usable notary method and trusted execution boundary. Forbidden metadata reads establish **unknown**, never absent credentials/protection. | #385 handoff; actual signed production/verification is #602. No credential provisioning is implied. |
| Casey / release and private-delivery owners | Confirm approved version/channel/plist mapping, supported minimum macOS, trusted workflow/build provenance, per-file signing policy, private catalog/invitation route, freshness/expiry/revocation/retention and support destination. Supply independently accepted installed-image manifest pin and native policy selection. | Implemented adapters need these inputs; source version 0.6.0 and macOS 14+ validator-tool applicability do not assign beta/OS policy. |
| Delivery / packaged-test owners | Candidate-bound production-validator and browser-download receipts, actual arm64 app and authenticated bundled-daemon execution on the unchanged signed package, accepted gate/artifact/cancel/failure fixtures and supported provider versions. | #602; unsigned staging, external daemon smoke and source-built Windows receipts cannot substitute. |
| App / recovery owner | Bind mounted setup, saved-config review/Bind and ownership recovery to the exact candidate and native paths. Same-boot exited-writer reconciliation and person-confirmed previous-boot settlement are implemented; surviving/foreign writers and legacy uncertain claims remain refused. | Native acceptance under #602/#390, not missing #570 implementation. Preserve retained work and use explicit continuation; settlement alone is not work completion or updater quiescence. |
| Updater owner | Exact signed N/N+1 approval, natural drain/positive quiescence, automatic installation, continuity and coherent matching-binary/protected-state restore evidence. | #603; integrated composition is implemented, production activation remains held. |
| Diagnostics owner | Exact-candidate consent/authority/storage/isolation/resource and local Save/export evidence. Closed producers are composed; native load and physical proof remain open. | #604 plus retained #416/#469 non-Mac obligations. Corrected C15 managed memory still fails the 32 MiB gate; default-off inactive code is not acceptance. |
| Cal / provider-contract owner; Casey for additional product choices | Supported provider evidence contract/version, installed correspondence, exact-command and transferred live-callback lifetime actual-Cal proof. | #594; generic #393 closure and synthetic callbacks do not clear it. |
| Documentation / existing-Hub owner and physical coordinator / tester | Candidate-matched source/Hub revision and access-valid download/support links; actual device/session/agent consent and unassisted participant receipt. | #389 prepares; #390 accepts. Existing audience stays unchanged. Device access, installation, paid agent use and sharing require their own agreed scope. |

## Shared candidate-bound physical-Mac receipt

Reuse the [MAC-01–16 matrix](../native-mac-testing/test-matrix.md),
[evidence template](../native-mac-testing/evidence-template.md) and
[operator checklist](operator-checklist.md). Link one shared observation from each
consuming issue rather than duplicate journeys. All rows below remain **unpassed**.
The executor records pass/fail/blocked/not run for each actual attempt. Current
requirements are [#602 delivery](https://github.com/cschadewitz/Project_Orca/issues/602),
[#603 update/restore](https://github.com/cschadewitz/Project_Orca/issues/603),
[#604 diagnostics](https://github.com/cschadewitz/Project_Orca/issues/604) and
[#390 unassisted acceptance](https://github.com/cschadewitz/Project_Orca/issues/390).
The [corrected C15 receipt](../crash-recovery/windows-c15-corrected-followup.md)
records the unresolved managed-memory failure; it supplies no Darwin acceptance.

| Receipt section / consuming owner | Existing evidence to supply |
| --- | --- |
| Candidate identity / #602 | Exact source and harness SHA; trusted manifest and DMG/ZIP/contained-app digests; app/build/protocol, bundled-daemon and provider versions; approved signing identity/notary/staple records; actual model/chip/macOS, runtime architecture/translation, guide/sample revision, alias and consent reference. Keep unsupported combinations explicit. |
| Delivery and installed execution / #602 | Approved private invited-browser route, access/expiry/revocation checks without embedded credentials or implicit source access; trusted hashes and validator result; normal quarantine/Gatekeeper/Finder installation and first-open. Actual packaged arm64 app and authenticated owned bundled daemon, without checkout/PATH/daemon overrides; fresh/reused isolated state, sample, gates/artifacts/cancel/failure, quit/reopen, permissions, sleep/wake and accessibility observations. No unsigned fallback or security bypass. |
| Exact N/N+1 and restore / #603 | Bind both signed candidates. Approve the specific update; close new-work admission while existing work/authorized answers finish naturally; install automatically only after positive quiescence, preserving closure through accepted startup/health/identity. Stalled work defers; no force-kill. Record stale/changed approval, callbacks/drafts, interruption/restart/reboot/failure, Keychain/TCC/journal continuity and coherent protected-state plus matching-binary backup/restore. Rollback needs positive proof no newer writes are discarded; otherwise retain complete generations for explicit recovery. |
| Diagnostics consent, isolation and memory / #604, #416/#469 | Exact signed Darwin/Electron native load, APFS ownership/durability and separate diagnostics Keychain; explicit persistent default-off consent, zero pre-consent retention, opt-out/revocation/expiry/session-generation and same-boot/24-hour recovery bounds. Current/recovered immutable report-to-export byte identity, separate destination choice and Save/cancel/back/retry/races/cleanup; startup-before-handshake, offline/no-network, allowlist/redaction, crash/sleep/reboot uncertainty, keyboard/VoiceOver/disclosure. Measure 8 MiB controlled binary and 32 MiB combined-memory gates and paired execution. C15 managed-memory failure remains blocking; #597 defers only 4 ms, and the viewer is removed scope. |
| Unassisted first run / #390 | Target-like participant follows candidate-matched guide with no hidden coaching: delivery, JEV-free workspace/sample, one separately authorized real-agent run and support/recovery/diagnostics Save/export comprehension. Record any hints, defects/severity and guide corrections, linking #602/#603/#604 and #594 results. Device/installation/agent consent and workplace-sharing authority come from the tester/owner, not product approval. Resolve launch/security/data-loss blockers before wider invitation. |

Only safe codes, IDs/digests/byte counts and approved public identity facts belong in
shared receipts. Keep paths/raw native output and consented local exports private;
export does not upload or authorize sharing. No signed candidate or physical receipt
was created by this reconciliation.

## Executable preparation packet

The [packet generator](../../../tools/packaged-mac/acceptance-packet.js) emits
structured command vectors and acceptance blockers. It **executes no vector**,
reads no candidate files or credentials, and writes nothing. Its input paths are
local execution selections, not evidence, a delivery manifest or filesystem authority.
All artifact/identity hashes must later match independently trusted delivery-v1
metadata, rather than checksums regenerated from a download.

From a clean committed checkout with existing locked dependencies, select the full
immutable source SHA and actual locally reviewed paths. This example is syntax only;
the paths intentionally refer to nonexistent local selections. Keep generated packets
private because real selections disclose account/scratch paths.

```sh
node tools/packaged-mac/acceptance-packet.js \
  --source-commit <full-selected-clean-SHA> \
  --stapled-app /private/candidate/stapled/ORCA.app \
  --dmg /private/candidate/delivery/ORCA.dmg \
  --zip /private/candidate/delivery/ORCA.zip \
  --dmg-app /private/candidate/dmg-copy/ORCA.app \
  --zip-app /private/candidate/zip-copy/ORCA.app \
  --account-home /Users/disposable \
  --temporary-directory /private/candidate/scratch
```

Unknown/missing/duplicate arguments, dirty/wrong source, changed ordinary signing policy,
malformed or reused/nested targets and unsafe scratch refuse with exit 2 and closed
codes. `--run` and `--mode candidate` are rejected. There is no implicit promotion,
invitation, source branch fallback or acceptance pass. The generator rechecks selected
source after generation, under the existing trusted/quiescent-checkout assumption.

The [unsigned staging helper](../../../tools/packaged-mac/packaging-plan.js) and
six unrun vectors from #555 remain unchanged. Reuse its recorded 25-test evidence;
it produces an unsigned directory, never a cohort DMG/ZIP.

## Actual arm64 command selections for a later authorized executor

First run `node tools/packaged-mac/executor-preflight.js` under a native arm64
tooling process. Exit 0 observes only tooling host/OS; Linux/x64 returns a blocker.
An arm64 runner label or an arm64 packaging target cannot prove product execution.
Tooling/runtime/account readiness and permissions remain separate prerequisites.

After a production identity is inserted and its app is actually signed, notarized,
stapled and accepted, the packet selects this exact container vector:

```sh
pnpm --filter @orca/app exec electron-builder --mac dmg zip --arm64 \
  --prepackaged /private/candidate/stapled/ORCA.app --publish never \
  -c.extraMetadata.version=<selected-source-version> \
  -c.directories.output=dist/release/mac-beta-containers
```

Locked builder parsing/normalization/config validation is tested without calling
build. `--prepackaged` skips `doPack`/identity/signing hooks; container generation
does not insert identity, sign/notarize the app or validate its architecture.
Use the same already accepted stapled app for both formats. DMG needs its separate
notary/staple step; ZIP needs its enclosed app ticket. Source version must equal
the approved candidate policy before this vector is authorized. No signing override
is added to the ordinary lane and no notary authentication command is provided.

After trusted containment/extraction, the packet has **20** observations: final
DMG/ZIP hashes, DMG ticket and DMG distribution assessment, then signature/publisher/entitlements/app ticket/
Gatekeeper/executable architecture/identity digest/daemon digest for each copy.
Each uses an absolute native command, explicit argument array, minimal PATH/LANG,
30-second timeout and 16 KiB ceiling per stdout/stderr stream. Execute serially, one worker, zero
automatic retries; stop on failure/overflow/timeout. At most 10 minutes of command
time is admitted for the complete observation selection. These vectors are suitable
for `execFile(command, args, {env, timeout: timeoutMs, maxBuffer: maxBufferBytes})`,
with no shell. No such native consumer ran in this lane.

App distribution checks select `/usr/bin/syspolicy_check distribution <app>` for
macOS 14+, following [Apple's current tooling guidance](https://developer.apple.com/documentation/macos-release-notes/macos-14-release-notes)
and [Apple DTS testing guidance](https://developer.apple.com/forums/thread/130560).
This check runs on the contained app, never on the DMG. The OS/tool gate is explicit;
older systems require a separately reviewed selection, not a silent fallback to the
less accurate legacy `spctl` app check. This selects a tool applicability boundary,
not the unresolved supported-OS floor. Physical first-open remains required.
The DMG assessment uses `spctl --assess --type open --context context:primary-signature`;
the app's `syspolicy_check` cannot assess a disk-image target.

Raw codesign/shasum output includes paths and must stay local. Retain closed outcomes
and approved public identity fields only. A zero tool exit is one observation, not a
production candidate validation result. The implemented production verifier parses
and binds these results against trusted policy and both copies' containment; its actual signed native execution remains
unpassed. The packet observations alone cannot replace that validator.
`lipo` inspects an executable slice, not a running process. The bundled `.mjs` is
JavaScript executed by the packaged Electron executable; record actual app/owned
daemon architecture and translation status using the native harness.

The two launch descriptors select each copy's actual
`ORCA.app/Contents/MacOS/ORCA`, with no arguments and exactly HOME/TMPDIR/PATH/LANG/
LC_CTYPE from the existing environment helper. They remain **blocked** until signed
validation, GUI, isolation and unchanged signed-app automation are proven. No external
daemon, developer checkout/PATH, renderer override, token injection or sandbox bypass
is used. Direct executable launch is a controlled executor observation; normal
browser/Finder opening and quarantine behavior remain a separate physical journey.
Required GUI context must be reviewed explicitly rather than inherited wholesale.

After those prerequisites, the future harness performs real Config actions for both
formats with fresh then reused isolated state. Bound each connection/sample wait to
60 seconds and ordinary Quit/owned direct-child terminal observation to 5 seconds;
record failure/uncertainty and retain owned state on timeout. Do not kill a PID, delete
the workspace or claim cleanup because a launch command returned. No automatic retry;
one explicitly reviewed reopen and one explicit recovery attempt per case retain the
first result. Use the implemented ownership-recovery contract linked above; its
exact signed Mac behavior remains unpassed.

## Mounted controls and sample oracles

Current main retains #567's mounted Config **Dedicated project setup** while
disconnected. The exact sequence is **Choose project and empty workspace** → review project/branch/base,
separate empty app workspace and sample identity → **Create reviewed sample files**
→ **Connect selected local workspace**. Cancellation preserves the previous selection.
Setup needs an already prepared owned attached Git checkout; it does not create one.
**Open a store…** remains read-only. With no explicit target/verified receipt, startup
is inert; the old main/home-fallback statement in #555 is historical.

**Launch work** is mounted in Config and **⌘K → Launch or recover work** opens it.
Choose **Choose harmless launch smoke check**, then **Preview launch**, review the
configured permission-policy checkbox and **Launch** once. Exact sample:

- ID `orca-beta-local-check`, version `1`.
- Revision `sha256:31027c78fb1ea553caf218b8366e7ea08d6a141efce5cb53b32e781fd7390567`.
- Fixed task, instruction and result revisions come from #567's
  `packages/app/src/first-run-sample.ts`; sealed candidate validation must match them.
- Success: actual run ID, selected workspace/instance identity, workflow ID/version/
  revision, terminal `succeeded` and end message: “Harmless local sample completed.
  No agent was started and no project files were changed.” The run variables contain
  the local marker. `first-run/result.json` is a prepared expectation, not a newly
  produced run artifact.

This start/set/end graph has **no agent, gate, permission request or output artifact**.
It can provide launch-smoke evidence for MAC-06, never satisfy MAC-06's report oracle,
MAC-07's gate/permission variants or MAC-08's held cancellation/failure variants.
Those fixtures remain an exact packaged-test owner prerequisite. The separate
`beta-first-job-v1` coding exercise still needs an explicitly authorized real agent.
No JEV setup/workflow is included.

**Recover original launch** concerns retained intent only. Ownership recovery uses
**Review same-boot recovery** then **Reconcile same-boot ownership**; a positively
quiescent supported writer may settle, while surviving/foreign or legacy uncertain
writers remain preserved/refused. Previous-boot settlement uses the separate explicit
**Mark previous session ended** confirmation under the current recovery contract.
**Review saved configuration for reopening** and reviewed Bind are implemented;
actual candidate-matched real-agent persistence/rebind still needs acceptance.
Repeated Connect, abandoning an intent or choosing another workspace cannot substitute
for recovery, and settlement does not automatically continue old work.

## Evidence and closeout

Use the [MAC-01–16 matrix](../native-mac-testing/test-matrix.md) and corrected
[evidence template](../native-mac-testing/evidence-template.md). Record source,
harness, both container and contained-app identities, guide/sample revision and actual
hardware/OS/runtime observations. Keep source/fixture, hosted arm64 candidate execution
and physical unassisted acceptance in separate result columns. Missing prerequisites
are **blocked**; attempted failed oracles are **fail**; unexecuted cases are **not run**.
No skipped launch, unsigned fallback or synthetically populated report is a pass.

Apply #416's stricter privacy boundary: no raw logs, traces, screenshots, environments,
personal paths, token/protected stores, prompts/code/output or credential-bearing URLs.
The artifact oracle records IDs/digests/byte counts, not contents. Private local native
records and generated packets must be sanitized before sharing. Ordinary status/enum
assertions are at most 256 KiB; optional validated manual diagnostic export stays under
#416's complete-report 1 MiB cap, with its own consent. No upload is implied.

The [guide](getting-started-draft.md) now names these pinned controls and limits.
Hub remains unchanged. #385/#388/#389 retain their pre-Mac scope; #602/#603/#604
and #390 retain the transferred live-Mac gates. This reconciliation closes none.
Root owns composition/CI disposition; recovery, updater, diagnostics, signed
candidate production and later execution remain with their named owners.
