# Native delivery source adapters — 9 October 2026

This implements the portable source gaps in #385/#388 on #580
`b45b2a0d7df15798e6ba985d71f6e9d507d9cee4`, preserving #574
`455b1e05f3e3a83175678e8a90f181e30244f966`, and importing #573
`5af9f43a8f17937ee08f1ed93d823d8ae7440c52` without refreshing those branches.
The existing [delivery-v1 contract](artifact-contract.md), build identity,
authenticated bundle probe, ZIP parser and native resource hooks are reused.
No shared main/preload/bridge/Workspace entrypoint changes are included.

The code is callable by a later authorized native executor. This source review ran
on Linux. No Apple tool, signing/notary operation, app installation, workflow,
release, delivery/access change or physical acceptance ran. Controlled fixtures
exercise refusal and composition; they do not establish signed acceptance.

## Identity before signing

[The native producer](../../../packages/app/scripts/native-mac-candidate-identity.js)
is separate from the still fixture-only producer CLI. It requires a native arm64
Node process on macOS and the operator's explicit policy matching public GitHub
Actions source, run, attempt, repository and workflow-ref/SHA observations. It
requires a clean exact checkout, locked installed tools and the pinned pnpm
version. Environment observations establish consistency, not runner protection;
only the authorized custodian can establish that external trust boundary.

The policy input is an executor selection, not another delivery manifest. It has
`kind: candidate`, `sourceCommit`, approved `appVersion`, `buildId` using the existing
`gha:RUN_ID:RUN_ATTEMPT:mac-arm64` format, `workflowRef`, `workflowSha`, `bundleId`,
`expectedTeamId`, `platform`, `arch`, `protocol`, explicit `bundleShortVersion`,
`bundleVersion` and `minimumMacOS`. No value is defaulted from an unresolved decision.
Root version 0.6.0 does not assign a beta version/channel. A source/version mismatch
refuses; this tool does not stamp a new release into source.

The producer observes the actual unsigned root app, plist, packed app version,
executable architecture, macOS and Xcode versions. It forces TypeScript and renderer
rebuilds, compares complete packaged `dist` file coverage and bytes with the fresh
outputs and all packed protocol JavaScript with fresh compiled source, rebuilds the daemon, compares the actual bundled bytes, reads compiled
protocol and reuses the owned authenticated daemon probe. That probe uses the build
Node runtime and synthetic state; it is not packaged Electron execution. Source,
lock, workflow facts, staged daemon and plist are checked again before insertion.

Only delivery-v1 fields enter `Contents/Resources/orca-build.json`, created with
exclusive creation before signing. A new detached directory receives
`candidate-provenance.json`, including the exact identity/digest, lock digest,
workflow/source/build facts and observed tools. There is no overwrite or recovery
promotion. A partial failed write has no valid success receipt and must be retained
for inspection rather than silently retried or treated as accepted.

The exported `afterPackCandidate` hook first invokes #574's actual copied-resource
verification, then requires explicit `ORCA_MAC_IDENTITY_POLICY` and
`ORCA_MAC_IDENTITY_RECEIPT` paths. It is **not selected by the ordinary config**.
Builder's prepackaged container pass bypasses identity/signing hooks, so the
identity must already exist in the accepted app used for both containers.
No signing or notarization overlay, entitlement choice or workflow activation is
made here. The original diagnostics hooks, default-off capture and unsigned lane
remain in effect.

## Trusted signed-candidate validation

The existing [single validator](../../../tools/deploy/native-mac-verify.py) now
routes explicit candidate mode to [its native adapter](../../../tools/deploy/native-mac-candidate.py).
Fixture mode retains separate-tree behavior and cannot promote candidates.
The candidate CLI requires `--trusted-policy` and `--scratch-parent` as well as
the delivery directory. The scratch parent must be a real directory owned by the
current executor with mode 0700, on an isolated local filesystem.

The independently authenticated policy has exactly these fields:

| Field | Required origin and comparison |
| --- | --- |
| `manifestSha256` | Final manifest digest from trusted promotion/catalog records, obtained independently of the downloaded directory. |
| `identity`, `identitySha256` | Expected delivery-v1 identity and exact sealed bytes' digest, bound to the selected protected producer receipt. Existing identity schema validation is reused. |
| `minimumMacOS` | Explicit approved policy, equal to final app plist. |
| `signing` | Exactly `teamId`, `certificateSha256`, `authority`; approved Team `Q2FP9UY5T4`, independently confirmed public Developer ID Application certificate fingerprint and authority. |
| `notarization` | Existing v1 `app`/`dmg` submission records, from independently trusted accepted custodian receipts, including pre-stapling submitted digests and referenced log paths. Never substitute final container digests. |
| `code` | Closed map keyed by `ORCA.app` and every real nested code bundle/Mach-O path. Each record has exact `identifier`, `entitlements` dictionary and Boolean `hardenedRuntime`. Root identifier/runtime are required. Per-file approval is an owner input, not learned from a download. |

This policy is an invocation trust anchor, not a replacement artifact schema.
Do not generate it by copying declarations or rehashing a downloaded candidate.
Authenticating that input and its promotion/notary records remains the caller's
responsibility. A missing policy or native executor refuses. No catalog route,
repository token, notary login or keychain discovery is added.

The adapter pins the manifest before native operations, reuses the common v1
structure/checksum/evidence validator, and rejects downloaded symlinks and metadata
overflow. It requires an arm64 macOS 14+ executor for `syspolicy_check`. This is the
tool applicability boundary, **not an assignment of the supported OS floor**.

For both contained app copies it verifies each inventoried Mach-O/bundle against
an explicit Apple Developer ID requirement, strict signature validity, expected
Team/authority, secure timestamp, exact public DER leaf certificate digest,
per-file identifier/runtime/entitlements and native arm64 slices. Closed policy
coverage prevents ignored new code. It verifies the entire root resource seal,
sealed identity/daemon/plist, packed app version, actual Electron framework version, stapled app tickets and
`syspolicy_check distribution`. The DMG has separate signature, certificate,
timestamp, staple and `spctl --type open --context context:primary-signature` checks.
Pinned submission receipts remain distinct from ticket and distribution checks.

Apple's [testing guidance](https://developer.apple.com/forums/thread/130560)
distinguishes command-line checks from browser download and normal first open;
its [certificate guidance](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates)
describes signature/certificate inspection. Native command compatibility and actual
signed negative cases still need device execution. A validator pass expressly leaves
packaged runtime, private-route access and physical acceptance unrun.

## Containment and bounds

[Native containment](../../../tools/packaged-mac/native-containment.py) reuses the
existing bounded ZIP parser, including full central/local record accounting,
streamed CRC/digest verification, Unicode/case collision and ancestor checks,
relative symlink resolution and sealed identity/plist/daemon comparison. Production
extraction requires explicit Unix ZIP permissions. Setuid/setgid/sticky nodes,
hardlinks, special nodes, escaping/dangling/cyclic links and unexpected image roots
refuse. Framework aliases may remain inside the app. The DMG's optional
`Applications` alias must be exactly `/Applications` and is never followed or copied.

DMG logical image size is checked before a read-only/no-browse/no-auto-open attachment
into fresh private scratch. Only the single mounted app plus bounded builder
presentation files are admitted. The mounted tree is inventoried without following
links and compared with its `ditto` copy. ZIP is fully preflighted before native
metadata-preserving extraction. Extracted tree membership, regular-file bytes and
permission modes, and relative link targets must equal the ZIP inventory and the
DMG copy. Root/nested signatures independently validate native signed metadata;
this comparison is not a claim of ACL/ownership/quarantine equivalence. Native
metadata/ACL/privacy behavior and browser-created quarantine still need acceptance.
Final containers/manifest are rehashed, and app bytes rechecked after native checks.

Limits are fixed: each container at most 2 GiB, ZIP central directory 16 MiB,
50,000 members, each expanded file 512 MiB, app total 4 GiB, ratio 1000, path 4096
bytes/64 components, 100,000 nodes, 2048 links/40 hops. Identity/plist/package metadata
are at most 1 MiB. ASAR header allocation is capped at 16 MiB and packed package
reads remain inside its indexed boundary. Evidence is at most 64 files of 1 MiB.
At the DMG-copy boundary, mounted app and copy can together reach 8 GiB; after
detach the two extracted copies can reach 8 GiB, in addition to input containers
and image backing storage. The executor must provision private scratch accordingly.

Native commands run serially with absolute paths, minimal environment, no shell,
30-second timeout, 16 KiB per stream, a 600-second aggregate tool budget and
2048-command ceiling. One bounded 30-second detach cleanup is permitted beyond that
budget. Tool subprocess timeout/overflow kills/reaps only the owned direct tool
child. It does not stop an installed app or force-unmount any image. Uncertain
attachment/detach failure refuses success and retains scratch without automatic retry; no success is emitted
until the context has completed cleanup. Inputs/scratch must stay trusted and
quiescent: this source does not implement a hostile concurrent writer sandbox.

## Ordinary desktop staging

[Desktop](../../../.github/workflows/desktop.yml) now downloads headers for the exact
setup-node runtime from the official HTTPS Node release endpoint, verifies the
archive against its exact `SHASUMS256.txt` entry before unpacking, and calls
[the staging driver](../../../tools/packaged-mac/stage-native-addons.js) before
`Package`. The driver derives the unique requested architectures from the existing
Mac target config, invokes #574's explicit local compiler once per architecture,
and verifies each stage. Current targets request arm64 and x64. Missing/ambiguous/
unsupported targets, download/checksum/compiler/resource failures stop packaging.
Existing beforePack/afterPack checks remain mandatory. This workflow was edited,
never dispatched; native compiler/loading and actual header fetching remain unrun.

## Remaining owner decisions and acceptance

Candidate version/channel, explicit short/build plist mapping, supported minimum
macOS, exact trusted workflow/protection provenance, publisher/certificate usability,
reviewed per-file entitlement/runtime policy, usable notary method and authorized
private invite/download/support route remain explicit owner inputs. Earlier Forbidden
signing-secret/environment metadata means **unknown**, not absent. No secrets or
signing metadata were inspected in this work.

Native compilation/loading, real signed positive/negative candidate validation,
authenticated packaged app/bundled-daemon execution, sample/gate/lifecycle behavior,
signed N→N+1 continuity and diagnostics privacy remain device/owner gates. #573's
sample still has no produced artifact or gate. Browser/Finder/Gatekeeper/TCC/
accessibility and unassisted #390 results remain physical acceptance. #385/#388
stay open. The [pinned acceptance handoff](../native-mac-beta-readiness/acceptance-runbook.md)
and [operator checklist](../native-mac-beta-readiness/operator-checklist.md) retain
those distinctions; they do not themselves run these adapters.

## Focused source verification

Node 24.19.0 and already installed Vitest 5.0.2/Prettier/ESLint were used; no
installation, dependency/lockfile regeneration, broad suite, coverage or workflow
execution. Pnpm was not invoked locally. No TypeScript source was changed.

- **66 tests pass in five JavaScript files**, one worker, 2.36 seconds: native
  candidate identity, staging, existing fixture identity/validator integration and
  actual builder resource-copy hooks. The locked ASAR library creates/parses inert
  archives and refuses changed or omitted compiled app/protocol bytes. An initial
  leading-slash ASAR read mismatch was found and fixed before the final pass.
- **50 Python tests pass**, 1.60 seconds: the existing 37 delivery-v1 fixture cases
  plus 13 candidate tests using controlled native ports. They cover independent
  pins, unsupported executor/closed CLI output, containment/equivalence, signature/
  certificate/entitlement/architecture/ticket refusal, code coverage, ASAR/image/tree
  limits and retained scratch on failed or unconfirmed detach. A real disposable
  Python child exercises bounded output/timeout; no Apple tool is launched.
- **46 existing ZIP containment tests pass**, 2.19 seconds, reusing malformed
  framing, compression, Unicode, symlink and sealed-resource cases.
- Changed JavaScript ESLint/Prettier, workflow YAML parsing and staging Bash syntax,
  diff whitespace, UTF-8/LF/newline/fences and local documentation links pass.
  Exact #573/#574/#580 ancestry and unchanged shared entrypoint blobs are verified.

Self-review also tightened the Apple Developer ID requirement, expanded-image size
bound, full compiled output/protocol comparison, actual Electron/plist facts,
certificate-chain output bounds and single-attempt detach confirmation. These
**162 distinct focused cases** are source/controlled-port evidence only; actual
Darwin compilation, command compatibility, signing and downloaded acceptance
remain not run.
