# Bounded native Mac acceptance handoff — 9 October 2026

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

## Exact missing handoffs

| Owner | Required non-secret output | Gate that remains blocked |
| --- | --- | --- |
| Casey / existing Apple custodian | Confirmation of existing distribution authority for Team `Q2FP9UY5T4`, valid Developer ID Application certificate/private-key usability and public fingerprint/expiry; one usable notary method and trusted existing execution boundary | #385 signing. Earlier metadata reads returned Forbidden: provisioning/protection are **unknown**, not absent. No keys, passwords, credential reads, enrollment or access changes requested here. |
| Casey / release owner | Approved candidate version/channel, explicit short/build plist mapping, minimum macOS and exact trusted source/workflow/build provenance | #385 producer. Root version 0.6.0 is a source fact, not an assigned beta version. Delivery v1 currently specifies `gha:RUN_ID:RUN_ATTEMPT:mac-arm64`; an arbitrary local-build ID cannot silently replace it. |
| Producer/signing owner | Production delivery-v1 identity adapter with actual lock/toolchain/plist/compiled protocol/authenticated daemon observations, inserted before signing; reviewed hardened-runtime/per-file entitlement and hook sequence; preserved RunAsNode behavior | `packages/app/scripts/native-mac-identity.js` remains fixture-only. Its producer receipt and #467 adapter cannot be promoted to candidate evidence. Ordinary `identity: null` / `notarize: false` remains unchanged. |
| Native validator owner | Actual DMG/ZIP containment and extracted-copy equivalence; native signature, expected publisher/certificate, entitlements, sealed identity/daemon/plist, tickets and final hashes; trusted metadata/provenance and negative cases | `tools/deploy/native-mac-verify.py --mode candidate` refuses before file reads. ZIP containment also refuses candidate mode. No candidate acceptance CLI currently exists. Reuse delivery v1 and its validator seam; do not introduce a second delivery manifest. |
| Private delivery owner | Existing approved HTTPS catalog, invite/download authentication and expiry/revocation policy, immutable asset IDs/digests, retention and support contact; exact browser download and denied/expired/revoked HEAD/Range results | #385 delivery. Existing Windows feed and `updates.invalid` are not a Mac route. Invited users must not need repository membership or credential URLs. No publication or invitation occurs here. |
| App integration / #570 owner | Final coherent head, supported orphan reconciliation and owned writer/store proof, exact first-run receipt/sample binding, native profile/store paths and actual daemon/runtime architecture | #386/#390 crash recovery. #569's surviving-owner terminal evidence permits ordinary reuse; app loss without that evidence remains blocked. Intent recovery, PID disappearance, timeout and lease expiry do not reconcile daemon ownership. This lane touches no shared main/preload/Workspace entrypoint. |
| Config / agent owner | Supported tool/adapter/version, Finder Git/tool availability, sign-in/transmission/cost review and persistence/rebind of applied real-agent config through Quit/reopen | #386/#390 real-agent run. Setup freezes the agent-free config/assets; changing them is not yet a proven persistent first-run journey. JEV is excluded. |
| Packaged test owner | Already provisioned arm64 macOS GUI/account/scratch, safe extraction/containment, signed-app automation compatibility, actual process observations and gate/artifact/cancel/failure fixtures | #388. No executable packaged Mac E2E project exists yet. Existing `app:smoke` supplies an external demo daemon; `app:type-proof` uses the development renderer. Neither command is a candidate test. |
| #387 / #416 owners | Candidate-matched signed N→N+1 and complete protected-state recovery; actual default-off diagnostics opt-in/preview/local Save/cancel/startup/no-upload/privacy/retention results | Hard #390 gates. Link those owners' evidence; do not duplicate their implementations or accept disabled capture as a pass. |
| Hub / physical owner | Candidate-matched versioned guide and existing-Hub revision, access-valid download/support links, separately agreed device/session/agent scope and unassisted participant results | #389/#390. Physical Mac model/chip/OS/build, Finder/quarantine/Gatekeeper/TCC/VoiceOver/sleep and usability cannot be inferred from source or hosted CI. Relevant M10 actual-Cal and M21 outcomes still apply. |

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
production candidate validation result. The production verifier still has to parse
and bind actual results, compare certificate policy and all sealed identity/plist/
daemon facts, recursively enforce per-file policy and prove both copies' containment.
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
first result. #570 must supply crash/relaunch semantics before that case can pass.

## Pinned real controls and sample oracles

At #567, Config mounts **Dedicated project setup** while disconnected. The exact
sequence is **Choose project and empty workspace** → review project/branch/base,
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

**Recover original launch** concerns retained intent only. At #569, uncertain daemon
ownership after losing the app still requires #570; repeatedly clicking Connect,
abandoning an intent or choosing another folder does not recover retained old work.
New independent work in a separately reviewed empty app workspace preserves the old
one but is not a recovery pass. Real-agent config edits still need persistence/rebind
acceptance because setup re-verifies its exact frozen config/assets at startup.

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
Hub remains unchanged. #385/#388/#389/#390 stay open until their own candidate,
delivery/native, publication and physical evidence exists; this preparation PR closes
none. Root owns composition/CI disposition; recovery, updater, diagnostics, signed
candidate production and later execution remain with their named owners.
