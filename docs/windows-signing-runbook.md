# Windows signing runbook

Prepared 30 October 2026 against ORCA source `85b7ceb99aa63a4f17fc2b50cc3546410321fe68`.
This is a preparation and implementation plan. It does not provision Azure, accept
agreements, purchase a service, create credentials, change CI permissions, sign a
candidate, publish a release or prove Windows acceptance.

## Recommendation and effort

Continue to describe current builds as unsigned. When signing is wanted, use Azure
Artifact Signing Public Trust if the chosen publisher is eligible, with a dedicated
GitHub Actions identity authenticated through OIDC. OIDC exchanges a short-lived
GitHub identity token for Azure access; there is no reusable client password to store.
Keep signing separate from release/feed publication authority.

Planning estimates, not measured promises:

| Work | Owner effort | Elapsed time / dependency |
| --- | --- | --- |
| Choose publisher, billing owner and region; review terms and identity details | Casey: 30–60 minutes | Before creating paid resources |
| Azure onboarding and identity submission | Casey with Azure administrator: 30–90 minutes, plus any follow-up | Microsoft quotes 1–20 business days, potentially longer for extra documentation |
| OIDC, builder integration, verification gate and review | Implementer: 1–2 working days | After identity/profile availability; includes resolving the v26/module and native-addon boundaries below |
| First signed install/update acceptance | Release tester: 2–4 hours initially | Reusable Windows VM ready; separate ARM64 hardware/VM required for ARM64 runtime proof |
| Later releases | Automated verification plus the normal packaged release checklist | No new identity submission per build; monitor validation expiry and service notices |

The largest external wait is identity verification. We can draft/review the CI change
while waiting, but cannot call the signing path accepted until real signed candidates
pass. Windows signing is independent of Apple signing/notarization.

## What is true in ORCA today

| Source | Current behavior |
| --- | --- |
| [App manifest](../packages/app/package.json) / [lockfile](../pnpm-lock.yaml) | Electron `^44.9.1`, electron-builder `^26.18.0`, updater `^6.8.11`; lockfile resolves builder `26.18.0` and updater `6.8.11`. A stale installed dependency directory is not proof of those versions. |
| [Builder configuration](../packages/app/electron-builder.yml) | Windows NSIS and ZIP, each x64/ARM64; per-user installer; `win.appId: dev.orca.desktop`. No Windows signing identity or Azure signing options configured. |
| [Desktop workflow](../.github/workflows/desktop.yml) | Separate architecture packaging with `--publish never`, root release version override and `latest-ARCH` / prerelease channels. The ordinary path is unsigned. |
| [Release workflow](../.github/workflows/release-publish.yml) / [update guide](UPDATING.md) | Publication happens separately, after checks/builds; installer hashes and blockmaps are checked. These checks do not verify a Windows publisher. |
| [Updater driver](../packages/app/src/main/update-driver.ts) | Packaged Windows only; authenticated HTTPS generic feed, architecture-specific channel, explicit download/install, prereleases/downgrades refused. No custom signature-verification override. |

Preserve the Windows app ID, installer identity, product name, per-user scope, artifact
names, architecture channels and update controls. A certificate publisher name is a
different identity from `appId`; adding signing does not require changing that ID.
See [existing-installation constraints](RELEASING.md#approved-application-identity-and-existing-installations).

Unsigned means Windows cannot authenticate ORCA's publisher through an Authenticode
signature. Signing adds publisher authentication and tamper detection. SmartScreen
also evaluates reputation; a valid signature does not guarantee a warning-free download.
EV certificates no longer grant an automatic SmartScreen bypass. Windows/enterprise
policy can block execution entirely. Record the actual prompt and OS policy during
testing; do not promise a fixed number of downloads or days to remove warnings.
[Microsoft SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
is authoritative here; the v26 builder guide still contains an older EV reputation claim.

## Decisions Casey must make before setup

| Decision | Recommended starting point | Record before proceeding |
| --- | --- | --- |
| Publisher identity | A stable legal identity Casey is comfortable displaying publicly | Individual legal name or exact organization legal name; do not assume the product name “ORCA” is an eligible legal publisher |
| Eligibility | Check Public Trust availability for that entity | Individual developers: US/Canada. Organizations: US, Canada, EU, UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway or Israel, per current quickstart; recheck at enrollment |
| Billing and ownership | Owner-controlled Azure tenant and eligible paid subscription; Basic plan initially | Billing owner, subscription type, account administrator, monthly budget and terms approval |
| Certificate disclosure | Review Azure's certificate subject preview | Approved CN/organization/location fields and any optional address disclosure |
| Operational owners | Casey owns enrollment and release decisions | Named CI implementer, reviewer, recovery contact and backup administrator |
| Enablement boundary | Dedicated protected Windows signing lane | Allowed source refs, reviewers, release cohort and when unsigned distribution ends |

Individual validation currently requires an Azure billing account of type Individual
whose legal name/address match identity documents. Identity documents go directly to
Microsoft's verification flow, never to git, chat attachments or CI artifacts. Choose
the tenant/subscription carefully: Microsoft currently documents resource migration
limitations. [Azure setup/eligibility](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
and [service FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq).

The subscription must be paid: Microsoft excludes **free, trial and sponsored Azure
subscriptions** from Artifact Signing. Confirm an eligible subscription, such as
pay-as-you-go or an enterprise agreement, before attempting account/profile creation.
Any billing upgrade is a separate owner decision, not an action authorized by this plan.
[Microsoft's subscription restriction](https://learn.microsoft.com/en-us/azure/artifact-signing/faq#can-i-use-artifact-signing-with-a-free-trial-or-sponsored-azure-subscription).

Microsoft currently lists Basic at **US$9.99/month including 5,000 signatures**, then
US$0.005/additional signature; Premium US$99.99/month including 100,000. Count signed
files and retries across both architectures, not just releases or installers. Confirm
actual currency, taxes, region and billing terms before purchase; set budget alerts
(alerts are not a spending cap). [Microsoft service pricing](https://azure.microsoft.com/en-us/products/artifact-signing).

If ineligible, investigate a publicly trusted CA's cloud/HSM-backed signing offering
with compatible CI integration. Do not substitute a self-signed certificate as public
publisher trust or buy EV for an assumed SmartScreen bypass.
[Microsoft signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

## Future step 1: owner-led Azure setup

These are future operator actions, requiring the owner's decision to enable the service.

1. Confirm the chosen tenant, eligible paid subscription, billable plan and resource group. A subscription
   administrator registers `Microsoft.CodeSigning` if needed. Choose a supported account
   region and record its exact signing endpoint; publisher country and service region are
   separate choices.
2. Create the Artifact Signing account. Complete Public Trust identity validation in the
   Azure portal, using exact legal details and the owner-controlled verification contact.
3. After validation succeeds, create a **Public Trust** certificate profile. Public Trust
   Test and Private Trust profiles are not substitutes for public Windows trust. Review
   the certificate preview and retain the approved CN as the expected publisher.
4. Record nonsecret account/profile names, region endpoint, subscription/tenant identifiers,
   validation status/expiry and operational contacts in the restricted release record.

Use the [Azure quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
for the current portal flow and [trust models/resources](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-resources-roles)
for profile distinctions. Do not install test roots on acceptance machines.

Separate administrator permissions from the CI signer:

| Actor | Permission needed | Scope / limit |
| --- | --- | --- |
| Azure resource operator | Contributor or a suitable custom role for account/profile management; provider-registration permission separately if necessary | Dedicated resource group; no automatic subscription-wide CI role |
| Identity verifier | Artifact Signing Identity Verifier, plus at least subscription Reader as documented | Human performing validation; never assigned to CI |
| RBAC administrator | Role-assignment authority, e.g. User Access Administrator or suitably scoped Owner | Creates the narrow signer grant; not the CI runtime identity |
| Entra administrator/application owner | Authority under tenant policy to create/manage the app and its federated credential | Entra rights are separate from Azure resource Contributor |
| CI service principal | Artifact Signing Certificate Profile Signer | Exact certificate profile only; no Contributor, Owner or identity-verifier role |
| GitHub administrator | Manage signing environment, access rules and configuration | No provisioning permission for ordinary build jobs |

[Microsoft role assignment guidance](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)
documents the signer role and certificate-profile scope. Portal labels may still use
the former “Trusted Signing” name; verify the role's actual permissions.

## Future step 2: restricted CI identity using OIDC

1. Create a dedicated Entra application/service principal for ORCA Windows signing; no
   client secret, user password or exported signing key. Assign only the profile-scoped
   signer role. Keep publishing/feed identities separate.
2. Create a protected GitHub signing environment, proposed name `windows-signing`. Limit
   approved branches/tags and reviewers. Verify which protections the current private-repo
   GitHub plan supports. If required protection is unavailable, stop for a reviewed
   alternative rather than quietly creating an unprotected signing lane.
3. Configure Entra federation with issuer `https://token.actions.githubusercontent.com`,
   audience `api://AzureADTokenExchange`, and the exact subject for that repository and
   signing environment. Confirm actual claims without logging the token. Do not trust all
   branches, forks or pull requests. This repository was created in September 2026: current
   GitHub documentation says new repositories after 15 July use immutable owner/repository
   IDs in `sub`. Do not blindly paste the older name-only subject examples.
   [GitHub Azure OIDC guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
   and [subject format/reference](https://docs.github.com/en/actions/reference/security/oidc).
4. Store `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` as environment-scoped
   configuration (GitHub secrets match Microsoft's examples; the IDs are not passwords).
   Store endpoint/account/profile and expected publisher as reviewed configuration.
5. Grant only the Windows signing job `contents: read` and `id-token: write`. Authenticate
   with a reviewed commit pin of supported `azure/login` (v3 at this audit), then use its
   Azure CLI session for signing. Preserve post-job login cleanup. Other jobs have no
   Azure token permission. [Azure Login](https://github.com/Azure/login) and
   [Microsoft OIDC setup](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect).
6. Build only a reviewed immutable source SHA. The current reusable Desktop workflow can
   accept an input ref, so an approved workflow ref alone does not prove the checked-out
   source is approved. Validate both caller/source SHA and release version before signing;
   do not run PR-supplied scripts with signing access. Split the Windows job from the mixed
   platform matrix or provide an equally reviewed isolation boundary. Grant token access
   through the reusable-workflow caller too, without broadening unrelated jobs.

Use a clean ephemeral Windows runner. Pin actions and signing dependencies in the future
implementation and review signing/configuration changes before use. Do not cache Azure
CLI login directories or tokens. Successful OIDC login proves authentication, not profile
authorization or the full builder integration.

## Future step 3: integrate with builder 26.18.0

The locked builder supports `win.azureSignOptions`; its v26 option names still say
Trusted Signing. A proposed **signed-lane overlay**, merged with the existing config,
has this shape. This is an illustration, not an enabled or complete replacement config:

```yaml
forceCodeSigning: true
win:
  appId: dev.orca.desktop
  verifyUpdateCodeSignature: true
  azureSignOptions:
    publisherName: "<exact approved certificate CN>"
    endpoint: "<regional signing endpoint>"
    codeSigningAccountName: "<signing account>"
    certificateProfileName: "<Public Trust profile>"
    fileDigest: SHA256
    timestampDigest: SHA256
    timestampRfc3161: http://timestamp.acs.microsoft.com
```

Keep the existing targets, resources and hooks when applying an overlay. Do not configure
`azureSignOptions` together with `signtoolOptions`. The signed lane must stop if signing
is missing; ordinary development packaging need not acquire cloud signing authority.
[Builder v26 signing options](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)
and [Windows configuration](https://www.electron.build/v26/docs/win/).

There is a concrete compatibility boundary: the 26.18.0 implementation installs the
PowerShell **TrustedSigning** module with minimum version 0.5.0 and invokes
`Invoke-TrustedSigning`; it does not call the renamed Artifact Signing action directly.
Its publisher configuration also feeds generated updater configuration by default. These facts were
checked against the [published 26.18.0 package](https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.18.0.tgz),
whose SHA-512 matched this repository's lockfile. Do not assume current online examples
or the preinstalled node_modules directory prove the locked implementation works.

Perform an authorized unpublished signing spike with OIDC and **no client secret**.
The module uses DefaultAzureCredential and supports Azure CLI credentials; Microsoft's
action documents that OIDC-to-CLI approach. This is a supported direction, not an ORCA
acceptance claim. Check the installed module/runtime versions, actual selected identity,
PowerShell parameter handling and signed output. The builder's minimum-version module
install floats: merely preinstalling a pinned module does not pin what it subsequently
installs. [Module implementation](https://www.powershellgallery.com/packages/TrustedSigning/0.5.3/Content/TrustedSigning.psm1)
and [Microsoft signing action OIDC flow](https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md).

For a repeatable production lane, resolve that floating dependency in review. If the
built-in integration cannot be constrained or authenticated as required, use a reviewed
v26 `win.signtoolOptions.sign` hook calling pinned Microsoft SignTool/dlib with the OIDC
CLI session, and set `signtoolOptions.publisherName` to the approved CN. Remove the Azure
options in that alternative and set `signtoolOptions.signingHashAlgorithms: [sha256]`;
do not inherit the classic signer's dual-hash default for this SHA-256 service path.
The hook must sign each builder-requested file and fail on
errors; use an explicit credential chain. Microsoft's current direct integration requires
compatible SDK SignTool, matching dlib architecture and .NET runtime. Resolve/pin actual
versions at implementation rather than downloading “latest” on each release.
[Microsoft signing integrations](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations).

Inventory every executable in both outputs: installer, uninstaller, ORCA executable,
helpers, DLLs and native `.node` PE libraries. Builder defaults do not prove every DLL or
addon is signed. ORCA's [native packaging hook](../packages/app/scripts/diagnostics-native-package.js)
records exact addon byte counts/hashes with `stage: before-signing`; signing changes
those bytes. Adding `signExts` for `.node` without reconciling the manifest/hook order can
invalidate that evidence. Design and verify the before/after-signing evidence boundary
in the implementation; retain strict integrity checks. Do not disable the hook or relabel
the old manifest as proof of signed bytes. Preserve genuine third-party signatures and
record any explicitly reviewed coverage exception.

Sign inner binaries before packaging, then sign the installer through builder's normal
lifecycle, then compute final update metadata/blockmaps/checksums. Do not post-sign a
completed release installer and reuse metadata describing its earlier bytes. The ZIP
itself is not an Authenticode executable: verify its contained executable signatures and
record the final archive digest separately.

## Future step 4: verify before release

Timestamping is mandatory: Artifact Signing's signing certificates have short lifetimes
(Microsoft documents three days), so retain an RFC 3161 timestamp and verify the chain.
Use SHA-256 file/timestamp digests and the documented Microsoft timestamp service above.
Do not treat a successful signer invocation as sufficient release evidence.
[Microsoft timestamp/integration requirements](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations).

On a clean Windows acceptance VM, using a trusted Windows SDK SignTool, verify each file
in the reviewed executable inventory. Example verification only, after substituting one
exact candidate path:

```powershell
signtool verify /pa /all /v /tw "C:\ORCA-test\candidate.exe"
if ($LASTEXITCODE -ne 0) { throw "Signature or timestamp verification failed" }
Get-AuthenticodeSignature -LiteralPath "C:\ORCA-test\candidate.exe" |
  Select-Object Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

`/pa` selects Authenticode policy; `/all` checks all signatures; `/tw` warns for a missing
timestamp. SignTool distinguishes success (0), failure (1) and warnings (2); the release
gate rejects both nonzero outcomes. Check actual signer CN, chain, timestamp and revocation
result against the reviewed identity, not just the presence of a signature. PowerShell
output is supporting evidence, not a replacement for the gate. Do not change system time,
install roots or disable trust/revocation checks to make verification pass.
[SignTool reference](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
and [verification/exit codes](https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature).

For updater acceptance, inspect `resources/app-update.yml` in the actual packaged app:
the approved nonempty `publisherName` must be present and verification must remain enabled.
Config flags alone are not evidence that it was embedded. Preserve the driver's explicit
download/install and architecture restrictions. The first signed release can be installed
manually from the approved distribution source; an old unsigned client cannot retroactively
gain publisher authentication. Rehearse unsigned-to-signed install continuity separately.

Keep Azure's `azureSignOptions.publisherName` as the exact certificate **CN**, as its
integration requires. Separately evaluate **full distinguished-name (DN) matching for
the updater** before enabling signed updates. Locked updater 6.8.11 parses configured
DN attributes and checks every configured attribute against the signer subject; it warns
when it falls back to a bare CN. A value containing only `CN=...` is still a single-attribute
constraint, not a full-DN pin. Use the approved certificate's actual full subject, including
its validated organization/location fields where present; do not invent subject values.
These behaviors were checked in the [published updater 6.8.11 source](https://registry.npmjs.org/electron-updater/-/electron-updater-6.8.11.tgz),
whose SHA-512 matched the lockfile.

Builder 26.18.0's generic publish schema supports a `publish.publisherName` string array,
which can supply that distinct full-DN value to generated `app-update.yml` without
replacing Azure's required CN. Review this override in the signed-lane configuration and
prove its packaged output and native updater behavior. Do not leave a bare CN as an
alternative entry beside the DN: the updater accepts a match against any configured entry.
Test same-CN/different-subject rejection and a legitimate certificate renewal with the
approved subject. Subject-field changes require an explicit reviewed transition; full-DN
matching does not replace certificate-chain, timestamp or revocation validation.

| Acceptance case | Required result |
| --- | --- |
| Clean signed NSIS install and ZIP launch | Expected publisher and valid timestamp; app/bundled daemon launch; normal per-user install; downloaded-file and local-launch prompts recorded |
| Signed A → signed B, same publisher | Genuine packaged updater verifies and installs exact approved architecture/version; settings, intents, workspace and credential access preserved |
| Unsigned A → first signed B | Approved manual transition preserves install identity/data; document what the old client did and did not verify |
| Invalid/missing signature or valid wrong publisher | Candidate refused before installer execution; current app/workspace remain usable; cannot pass solely on hash/TLS |
| Full-DN policy: valid signature with same CN but different configured subject fields | Refused by the actual packaged updater; no CN-only fallback in the allowlist |
| Missing publisher metadata, wrong architecture/channel/version, damaged download | Explicit release/acceptance failure; no silent fallback or permissive verifier |
| Signing/timestamp service failure or revoked CI authority | No signed release assets admitted to publication; no unsigned fallback |
| Windows 10 22H2 x64 | Optional best-effort smoke when available, including real download/launch trust result; no claim of verification until exercised |
| ARM64 | Validate signatures and metadata for that output; x64 VM results do not establish native ARM64 execution |

For the wrong-publisher case, use a controlled validly signed fixture with an intentionally
different expected publisher in an isolated test build, or a preexisting authorized test
signer. Do not provision another paid identity just for a negative test. Recompute fixture
metadata so a hash failure does not mask publisher-verification behavior. Never publish
test feeds, weaken production verification or execute the refused fixture.

This signing work verifies application distribution trust. Existing-run archive/store
compatibility, daemon migrations and complete backup/restore remain separate upgrade
acceptance requirements in [UPDATING.md](UPDATING.md).

## Release evidence, operation and recovery

Retain source SHA/version, dependency/tool versions, CI run, artifact names/architectures,
final hashes, signer identity/chain and timestamp results, packaged publisher configuration,
positive/negative update outcomes and exact OS/VM build. Record SmartScreen warnings
as observed UX, independently from signature validity. Before admitting a signed candidate,
the publication gate must require this evidence for both architecture sets; preserve
`--publish never` in builder and the existing complete-release publication ordering.

Keep private keys service-managed. Never commit/export PFX material, identity documents,
access tokens, OIDC JWTs, CLI credential caches or client secrets. Endpoint/account/profile
and certificate subject are configuration, not authentication secrets. Restrict diagnostic
logs/artifacts and avoid verbose Azure authentication output. The OIDC plan needs no
`AZURE_CLIENT_SECRET`, `AZURE_USERNAME` or `AZURE_PASSWORD`; do not add them as a fallback.

Verify a retained timestamped sample again after its leaf signing certificate has expired,
using normal system time. This checks long-term validation separately from same-day success.

Assign an owner to review Azure identity-validation expiry notices, signing history,
unexpected signature usage, CI trust/configuration changes and budget alerts. Certificate
renewal should preserve the approved publisher name; do not pin a short-lived leaf
thumbprint as the updater's identity. A publisher-name change needs an explicit transition
plan (including a reviewed old/new publisher bridge where supported), two-version tests
and a new owner decision. Do not broaden the publisher allowlist speculatively.

On suspected compromise, stop new signing/publication, preserve evidence, and have the
authorized administrator revoke the CI federation/signer grant and assess certificate
revocation with Microsoft. These are incident actions requiring operator authority, not
steps performed by this runbook's preparation. Do not delete profiles or roll back an
installed daemon against a migrated workspace as an improvised recovery. Keep the last
verified release available and follow the complete backup/restore procedure for data.

Completion means a reviewed signing implementation plus real accepted signed artifacts
and updater tests. This document and successful unsigned builds do not satisfy that gate.
