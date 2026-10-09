# Native Mac candidate execution packet

**Historical 8 October packet.** The [9 October acceptance runbook](acceptance-runbook.md)
supersedes its UI/sample assumptions, reconciles #567/#569/#570 and supplies exact
bounded command selections. The new [guided operator checklist](operator-checklist.md)
is for the later session; the Mac is not yet available. Keep this packet's #555
staging/signing sequence and focused evidence as dated preparation, not current acceptance.

One self-reviewed preparation packet for #385/#388/#389 on 2026-10-08, based on
independently fetched main `db579fb7ac9cfce2e4e6901713088a80602311da`. Casey approved
parallel M10/M22 preparation; root owns final-main CI recovery, review/integration and
merges. This lane reuses merged #529/#541 and does not dispatch CI, sign, notarize,
publish a release, deploy, change credentials/access, or operate a tester's Mac.
Mac hardware is expected afternoon/evening; that is availability, not an executed pass.

## What already exists and what is unknown

| Prerequisite | Evidence from this audit | Consequence |
| --- | --- | --- |
| Approved publisher identifiers | `com.schadewitz.orca`, Apple Team `Q2FP9UY5T4`; approved in #456 and source/docs | Identifiers exist; certificate/private-key authority and membership remain unverified. |
| Packaging/bundle | `packages/app/electron-builder.yml`, `build-daemon.js`, authenticated standalone probe; installed/locked builder 26.15.3 and Electron 44.4.5; root 0.6.0, protocol 2.0, operator-journals-v4 | Reuse frozen source/build path. #513's 44.5.1 source proposal remains separate, not imported. Root version is not a beta assignment. |
| Signing/notarization | Ordinary config is literal `identity: null`, `notarize: false`; no explicit entitlements/hooks/OS floor in that config. `native-mac-identity.js` accepts only fixture mode | Signing is inactive. A production identity insertion/native verification adapter and reviewed entitlement/signing sequence are still missing; no fixture receipt can fill the gap. |
| Protected credential/environment metadata | Read-only GitHub secret-name/environment requests returned Forbidden. No secret contents, environment dumps, Keychain/key files or credential directories were read | Presence and protection are **unknown**, not absent. Dated comments saying no certificate exists are not current metadata evidence. Casey/custodian checks availability in the existing admin interface without pasting values. |
| Desktop workflow | Manual dispatch has no exact-source/version input; reusable `workflow_call` accepts them. Matrix includes homelab Linux and Mac/Windows. No Apple secrets/environment are bound | Do not dispatch the all-platform workflow for today's Mac check. Root resolves routing/source identity and any approved native execution; no workflow edit here. No additional homelab job without current CPU/RAM/load. |
| Private distribution | GitHub release path and optional private-feed publishing exist; feed script requires Windows latest/prerelease metadata. Mac origin/invite/revocation/retention is not configured in these sources | Existing Windows feed automation is not a proved Mac browser delivery path. `https://updates.invalid/` is a placeholder, not a destination. No source access or bearer URL substituted for invitation. |
| Artifact/test foundation | #529 executor/environment helper; #541 bounded ZIP containment; shared delivery-v1 fixture validator and #467 identity integration | Helpers remain fixture/source preparation. Candidate modes are refused; signed DMG containment/native verification and actual packaged execution are not implemented by these helpers. |
| First-run/launch/sample | Guided component/controller is merged but `App.tsx` registers the existing palette action; no integrated guided surface. Default workspace still falls back to home; store opening is read-only | Separate #334/#386 owner must supply final route, verified target/root and sample binding through root. No home-folder workaround, extra launcher or assumed `cal-codex-work` certification. |
| Updater/diagnostics | Source is merged/present, with inactive production native composition and outstanding acceptance | Their native owners supply signed N→N+1 and manual-diagnostics/privacy results. This packet consumes results by reference, not duplicate implementation or acceptance rows. |

## Exact safe staging path

The new [plan helper](../../../tools/packaged-mac/packaging-plan.js) is read-only.
From a clean, committed checkout with the locked builder dependencies already available,
run the following **plan-only** command locally (this can be the cloud preparation host):

```sh
node tools/packaged-mac/packaging-plan.js --source-commit <full-selected-clean-SHA>
```

It reuses `readSelectedSource`, binds root version/lock/protocol/store facts, checks the
typed ordinary unsigned policy and rereads clean source before returning a structured
argument-vector plan. `--run`, candidate mode, branch names, dirty/wrong source and
changed signing policy refuse with exit 2 and closed codes. No listed step executes.
Inputs assume a trusted quiescent checkout; this is not a hostile-writer attestation.

Root selects the final approved immutable source after integration/CI disposition;
the audit SHA above is not a promise to package today's unfinished UI. On a separately
authorized native Mac, use already approved/provisioned Node 24.21.0 / pnpm 12.4.2,
an isolated account with a GUI and private scratch. Confirm existing tooling and
Electron binary readiness; do not install a provider, acquire credentials, change
host policy, use a developer's personal workspace or silently substitute a runtime.
The planned frozen install may download the approved Electron binary; require root's
execution approval before running it. Keep signing/provider/daemon/Node injection
settings out of staging's environment; do not dump environment values to prove this.

Execute each reviewed vector from the repository root, serially:

1. `node tools/packaged-mac/executor-preflight.js`: must observe native arm64 tooling
   and exact OS/build. GUI and app/daemon architecture remain unchecked. Linux/x64
   block before native commands. Observation is not an installed-app pass.
2. Frozen install with `--frozen-lockfile --no-trust-lockfile`, ordinary build,
   existing daemon bundler and authenticated standalone probe. Preserve the frozen
   lock/trust/allowBuilds policy. The probe's sanitized result is standalone Node
   bundle evidence, not Electron or signing evidence.
3. The plan's final vector uses explicit `--mac dir --arm64 --publish never`, exact
   root version and `dist/release/mac-beta-staging`, with `-c.mac.identity=null`.
   It relies on the checked source's typed `notarize: false`: the locked CLI parses
   `-c.mac.notarize=false` as a string before config validation, so that ambiguous
   override is deliberately omitted. Tests prove the effective ordinary config stays
   unsigned/notarize-false and target selection is Mac arm64 directory only, despite
   the ordinary config's x64/arm64 container target arrays.

Stop on a failed step and retain only safe status/identity evidence. This is **unsigned
directory staging**, not a beta candidate, install test or invitation. It creates no
DMG/ZIP or delivery identity and must never be distributed to the invited cohort.
No app is launched by the plan/helper. Account, filesystem, profile, Keychain/TCC
and GUI isolation still require actual verification.

## Signed candidate path: ordered owner gates

There is no honest executable signed-candidate command in current main. In particular,
turning on `mac.identity` alone would not implement sealed build identity, final
container/ticket verification, access control or native acceptance. Finish these gates
before root authorizes that native run:

1. Freeze final source/workflow revision, candidate version/channel, explicit plist
   short/build versions, minimum macOS and expected public certificate fingerprint/
   expiry. Confirm existing Developer ID private-key availability and team authority,
   one approved notary authentication method and existing trusted signing account/
   runner boundary. Presence is not validity. No certificate/API key creation or
   credential installation is part of this task.
2. Implement/review the production identity and native packaging adapter against
   the existing delivery-v1 contract and locked builder. It must observe actual
   package/plist/toolchain/compiled protocol and authenticated daemon facts, bind
   source/lock/build provenance, insert identity **before signing**, preserve
   RunAsNode for the bundled daemon and prove final sealed resources. The fixture
   producer refuses candidates and must remain so; never relabel fixture output.
3. Review explicit minimal per-file hardened-runtime/entitlement policy and prove
   native hook ordering. With a separately authorized existing identity, sign the
   directory app, verify expected team/certificate/entitlements, notarize the app's
   submission archive and staple/validate the app. Use a single notary owner. Do not
   change the account Keychain search list, TCC, sandbox/fuses or security settings
   simply to get a passing run.
4. Create final DMG and ZIP from that same accepted stapled app without rebuilding
   or altering it. The locked builder's non-MAS `--prepackaged` path skips `doPack`,
   identity insertion and signing hooks; do not depend on those hooks during container
   creation. Notarize/staple/validate the DMG separately. ZIP itself is not stapled;
   its enclosed app must retain the accepted ticket. Reopen both final containers,
   verify contained identity/signature/resources and record final container hashes.
5. Build production delivery-v1 evidence/checksums only from those actual results.
   The current fixture validators and #541 candidate refusal do not validate this
   candidate. Native verification must independently use macOS tools and both real
   extracted copies, and refuse unknown/missing/tampered/unsigned/wrong-team results.
6. Only with separate delivery authorization, place immutable assets on the approved
   private route. Test exact invited download and denied/expired/revoked access for
   every asset, including HEAD/Range. No embedded repository token, credential URL,
   implicit source membership or broader Hub audience. Preserve downloaded hashes.

This sequence reuses [delivery design](../native-mac-delivery/delivery-design.md) and
[locked signing foundation](../native-mac-delivery/signing-foundation.md); it does not
activate them. D4/D5 and provider support are owner decisions, not defaults chosen here.

## Native execution and evidence oracles

Start from exact final DMG/ZIP bytes, trusted manifest/checksums, source/build IDs and
approved publisher. Use one worker/no automatic retries, a separate disposable account
and private root. Apply #529's minimal app environment with the actual account home and
owned scratch, no ORCA_DAEMON_URL/token/renderer/workspace or developer PATH override.
Verify actual profile/cache/log/store paths before sample writes. Merely assigning HOME
or `--user-data-dir` does not isolate Keychain/TCC/native state.

Before launch, the authorized native verifier observes `codesign --verify --deep --strict`,
displayed signature/team/entitlements, `spctl --assess --type execute`, and app/DMG
`xcrun stapler validate` on the appropriate targets. These are verification operations,
not commands run by this packet. Retain safe outcomes/fingerprints, not raw credential
or file-bearing output. Normal browser/Finder quarantine/Gatekeeper first-open remains
a separate physical test; no quarantine removal, ad-hoc re-signing or debug entitlement.

Then consume [MAC-01–15](../native-mac-testing/test-matrix.md) against the production
renderer and app-owned bundled daemon: exact arm64 app/daemon executable/resource and
parent/process association; valid auth and wrong/missing-token refusal; actual supplied
sample/artifact/gate/cancel; window close versus Quit/reopen; disconnect and denied
workspace/cancel/retry; Finder PATH and separately authorized agent; keyboard/VoiceOver/
themes/TCC/sleep/wake. UI writes must be the real user actions, not synthetic RPC setup.
Unknown sample/root/endpoint/architecture is blocked before writing. Prove unchanged
signed-app automation compatibility; no `--no-sandbox`, modified app or fuse relaxation.

MAC-16 references the updater lane's **own** signed N→N+1/complete protected-state
recovery results; do not clone its twelve rows here. #416's native owner supplies default-off,
actual opt-in/preview/exact local Save/cancel, startup-before-handshake, no-network,
bounded retention/resource/cleanup and unknown-outcome/privacy results on the exact
candidate. These remain hard #390 gates. #417/#418 are later work.

Record source/build/format/digests, actual model/chip/macOS build, host/app/daemon arch,
guide/sample revision, consent scope, pass/fail/blocked/not-run per case and safe evidence
references in the [existing evidence template](../native-mac-testing/evidence-template.md).
Use #416's stricter content exclusions: no raw log tails, environment dumps, traces,
screenshots, token/private key/journal/profile stores, provider prompts/code/output or
personal paths. Keep physical/private records out of Git. Normal Quit/owned-child/mount
cessation and path/marker authority precede cleanup; no reset/deletion shortcut.

## Current UI bindings for the guide

| Guide operation | Observed current source at the audit SHA | Acceptance boundary |
| --- | --- | --- |
| Inspect/reconnect | Bottom bar `connected`/`file mode`/`disconnected`; `Connect to a daemon…`, dialog `Use the bundled daemon`, `Cancel`, `Daemon URL` | Does not select a dedicated writable workspace. Native beta must not ask testers to paste tokens or start an external daemon. |
| Open history | File → `Open a store…` / ⌘O calls `workspace.open`, explicitly read-only | Never describe as first-run/sample workspace creation. Default startup still uses home unless configured; first-run owner must replace that unsafe-for-beta assumption. |
| Existing direct admission | ⌘K → `Start or recover a run`; workflow picker uses defaults; `Abandon retained run intent` does not cancel work | Not a replacement guided sample route, typed-input/Request flow or safe uncertainty workaround. |
| Guided surface | `Workspace root`, `Workflow`, `Request title/body`, `Preview launch`, `Launch`, `Recover original launch`, `Review target`, protected draft/launch controls exist in the unregistered component | Final route, root/sample/workflow and supported command/recovery bindings are separately being finished by #334/#386 owner. Root was asked to relay them; no guessed labels/registration/asset are presented as shipped. |
| Local diagnostics | `Local diagnostics`, `Keep off`, `Enable local diagnostics`; source says production capture unavailable; native clock/producer/adapter acceptance absent | Labels are source observations, not collection/export proof. Match actual validated preview/destination/Save/Cancel before tester handoff. |
| Local data | Source uses Electron userData for `preferences.json`, protected admission intents and diagnostics; daemon uses the selected workspace/store-root contract | Do not promise an absolute per-user path or migrate/delete data. First-run owner/native observation must provide actual dedicated workspace and exact local-data disclosure. |

The [updated guide source](getting-started-draft.md) now names those current controls
and blocks a walkthrough requiring missing guided/sample controls. Hub remains unchanged.
No UI/runtime source was edited. Root coordinates sample/workflow/route replies from the
integration owner; the offline shipping exercise is not a packaged credential-free sample.

## Casey's actions and timing

1. **Before the Mac session:** confirm with the existing Apple/certificate custodian
   whether the approved team's Developer ID certificate/private key and one notary method
   are already usable, plus the existing trusted signing execution boundary. Return only
   availability/authority and public fingerprint/expiry; never paste passwords, P12/P8,
   tokens or Keychain contents. If unavailable, tell root the exact prerequisite.
2. **Before candidate creation:** choose candidate version/channel, explicit plist mapping,
   minimum macOS and the existing approved private download/invite/revocation/retention
   route/support contact. Root needs those decisions and final #334/#386 sample/route
   binding before anyone can label an artifact beta-ready. No new access/credentials here.
3. **When hardware arrives afternoon/evening:** confirm physical model/chip/macOS and
   existing Node/pnpm/Xcode/GUI readiness, then agree the disposable account/workspace,
   permitted read-only observations and later install/test scope with root. Do not share
   screen dumps/secrets or provision/change the machine to work around a failed preflight.
4. **After source/native adapters and root's CI disposition are ready:** explicitly
   authorize the bounded native staging/signing/notary/test steps and any private delivery
   separately. Hardware alone does not unlock the missing candidate adapters. Root executes
   only the approved exact source and existing identity; this lane has executed none.
5. **After signed candidate and native owner results exist:** allow a consented unassisted
   guide/download/Finder walkthrough, then signed N→N+1 and diagnostics preview/local
   Save/cancel using their owners' procedures. Agree provider/tool/model, sign-in/cost and
   a stopping plan before the one real-agent exercise. Wider invitations wait for #390,
   #416 and relevant M10 actual-Cal/M21 outcomes; M3–M5/current macOS remain target coverage.

## Focused self-review record

The draft PR binds the final head and this one packet's outcomes. New tests exercise
exact argument vectors through installed/locked builder CLI normalization/configuration,
unknown/changed signing policy, injected/non-string source facts, no credential-field
retention and CLI refusal of execution/candidate options. No builder build function,
Apple tool, download, app, diagnostic collection or provider is invoked. Node 24.21.0 /
pnpm 12.4.2 verified the current lock's 535 supply-chain entries without policy exceptions.
Owned JavaScript lint/format, local Markdown links/fences/whitespace and exact scope are
checked; final focused tests pass **25/25, no skips**, owned JavaScript lint/format pass,
and four Markdown files/twenty-one local links/fragments/UTF-8/LF/fences/whitespace pass.
The final clean-source plan is generated after committing and before the one
normal publication. Initial parser validation caught the false-string override described
above; it was removed before the passing final run. No extra reviewer or broad suite;
root owns subsequent CI/merge. No signing/native/physical or parent-issue completion claimed.
