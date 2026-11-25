# Native Mac delivery prerequisites and decisions

As of **2026-10-03**, the owner has approved bundle ID **`com.schadewitz.orca`** and
Apple Team ID **`Q2FP9UY5T4`**. External provisioning remains **unknown / unverified**.
See [current identity and compatibility policy](../../RELEASING.md#approved-application-identity-and-existing-installations);
the [2026-10-02 source audit](current-state.md) remains historical evidence.
Preparation #402 does not authorize purchase, enrollment, credential creation, access
changes or release publication. #385's owner must confirm them before a signed run.
Names below are proposed bindings, never secret values. Source and tool context:
[audit](current-state.md), [delivery design](delivery-design.md).

## Owner actions and verification

| Owner role                      | Prerequisite / action requiring owner authorization                                                                                                                                                            | Verification before use                                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple account holder            | Confirm active Developer Program team, agreements and authority to distribute ORCA; use approved bundle ID `com.schadewitz.orca` and Team ID `Q2FP9UY5T4`. | Record approved Team ID, publisher and bundle identity in restricted release configuration; do not infer membership from repository comments.                                                                       |
| Certificate custodian           | Supply a valid Developer ID Application certificate with its private key and export password. No PKG/Developer ID Installer certificate is required for this plan.                                             | On the approved Mac runner, enumerate valid code-signing identities, match the expected team/certificate and verify a signed candidate. Record public certificate fingerprint/expiry, never the private key/export. |
| Apple account/API administrator | Approve one notary authentication method. Prefer a dedicated App Store Connect team API key; confirm its role and actual notary access with the account administrator.                                         | Credential validation and authorized notary submission succeed for the expected team; no credential or submission has been created by this preparation.                                                             |
| CI administrator                | Approve a protected signing environment and trusted arm64 macOS runner with working Xcode, `codesign`, `notarytool`, `stapler`, clock and network access.                                                      | Record OS/build, native architecture, Xcode/tools and signing capability. A moving runner label or installed CLI alone is insufficient.                                                                             |
| CI/release maintainer           | Restrict signing to reviewed immutable source and trusted workflow revisions; scope credentials to the Mac signing job.                                                                                        | Untrusted PR/fork paths cannot obtain keys; a missing secret fails preflight. Confirm reusable workflow/environment binding explicitly.                                                                             |
| Distribution owner              | Select/provision HTTPS hosting, per-user invitation/authentication, deployment account and catalog retention.                                                                                                  | Authorized invite downloads exact candidate; unauthenticated/expired/revoked identity cannot read any asset, including HEAD/Range. Repository membership is not required.                                           |
| Physical acceptance owner       | Supply a clean Apple Silicon account/device, supported macOS versions and time for a normal browser/Finder walkthrough.                                                                                        | Record hardware/OS, artifact digest, first-open result and bounded sanitized diagnostics. No device access or install is authorized here.                                                                           |

Apple's [Developer ID guide](https://developer.apple.com/developer-id/) identifies the
Account Holder responsibility for certificate creation. The
[Electron notary documentation](https://github.com/electron/notarize) describes a team
API key with App Manager access. That is an account-level permission decision, not a
claim of a narrowly scoped notary-only role. Individual API-key support in current tools
is not assumed to exist in the locked `@electron/notarize` 2.5.0. The fallback, only if
explicitly selected by the owner, is Apple ID + app-specific password + Team ID; never
the account login password. Guidance consulted 2026-10-02.

## Proposed secret/variable bindings

Reuse the names already documented in [RELEASING.md](../../../docs/RELEASING.md).
Their presence has not been checked and they are not presently forwarded by `desktop.yml`.

| Name                                                         | Meaning and intended scope                                                              | Consumer mapping                                                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE_P12`                                      | Secret: base64 certificate export including signing private key; protected Mac job only | Decode to a job-private temporary `.p12`; pass its path as builder `CSC_LINK`.                                                                                                                |
| `APPLE_CERTIFICATE_PASSWORD`                                 | Secret: password for that export; same scope                                            | Builder `CSC_KEY_PASSWORD`; never echo.                                                                                                                                                       |
| `APPLE_TEAM_ID`                                              | Approved public team identifier `Q2FP9UY5T4`; protected release configuration                        | Compare final signature team and constrain notary account; not a credential by itself.                                                                                                        |
| `ORCA_MAC_SIGNING_IDENTITY`                                  | Proposed public expected Developer ID identity/fingerprint; release configuration       | Explicit builder identity/`CSC_NAME` selection and post-sign verification; finalized with D1/D2.                                                                                              |
| `APPLE_API_KEY`                                              | Secret: `.p8` file contents, not a path in the secret store; protected notary step only | Write to a mode-0600 temporary file; notary tool key argument is the path. If using builder integration later, its `APPLE_API_KEY` environment variable also means a path, not file contents. |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`                       | Key/issuer identifiers; keep with the protected notary configuration                    | `notarytool` team-key authentication and temporary keychain profile.                                                                                                                          |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`                    | Alternative notary identity and secret; only if owner selects fallback                  | Temporary notary keychain profile with `APPLE_TEAM_ID`; do not provision both methods by default.                                                                                             |
| `ORCA_MAC_DOWNLOAD_HOST`, `ORCA_MAC_DOWNLOAD_ROOT`           | Proposed non-secret distribution destination; D3 unresolved                             | Mac-only promotion job, no client credentials in URLs.                                                                                                                                        |
| `ORCA_MAC_DOWNLOAD_SSH_KEY`, `ORCA_MAC_DOWNLOAD_KNOWN_HOSTS` | Proposed secret deployment key and pinned host trust data if SSH is chosen              | Promotion job only; write scope limited to Mac candidate directory. Never reuse as client read credentials.                                                                                   |

The SSH names are provisional counterparts to the existing `ORCA_FEED_*` pattern,
not additional credentials to create now. D3 may select a different deployment transport.
Browser sessions are issued by the download service and never appear in this repository
or the build. Local daemon authentication is a separate runtime credential and must not
be confused with download, GitHub or Apple authentication.

The signing implementation must choose one temporary-keychain lifecycle: either verified
builder-managed import/cleanup or an explicitly managed job keychain. Set restrictive
temporary file permissions, unlock only for signing, avoid shell tracing and environment
dumps, never cache/upload keychains or key files, and clean up on success, failure and
cancellation. Restore any keychain search-list change. Retain only sanitized public
verification evidence. Rotation/revocation is an owner action; it must not silently switch
the approved publisher.

[Builder signing variables](https://www.electron.build/docs/features/code-signing/)
and [GitHub secret handling](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
were consulted 2026-10-02. Reusable workflows do not automatically receive all secrets.
Choose explicit named forwarding or a protected environment on the called signing job;
document and test the chosen binding, including approval behavior and secret availability.
Do not expose keys to every platform through blanket inheritance.

## Decision register

These decisions do not block merging preparation. They block the dependent implementation
or delivery evidence; no placeholder may pass a real candidate gate.

| ID  | Decision owner            | Proposed direction / unresolved value                                                                                                                                                                                                    | Required before                                      |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| D1  | Apple/release owner       | Bundle ID `com.schadewitz.orca` and Team ID `Q2FP9UY5T4` approved 2026-10-03. Legal publisher, signing identity/fingerprint and provisioning authority remain unverified; signing activation is separate.                                                                                                    | Signing preflight configuration                      |
| D2  | Packaging maintainer      | Prove the locked builder schema, per-file entitlements and directory → stapled app → final containers sequence. Current rolling docs differ from local config; choose compatible overlay/hooks without a speculative dependency upgrade. | Executable signing implementation                    |
| D3  | Distribution owner        | Authenticated browser catalog on a dedicated HTTPS origin/path; host, identity provider, invite/revocation procedure, deployment transport and retention unknown.                                                                        | Download/promotion implementation and invite changes |
| D4  | Release + test owners     | Minimum supported macOS and physical test matrix; actual runner/Xcode image. No OS floor is promised by this preparation.                                                                                                                | Candidate creation and release acceptance            |
| D5  | Release owner             | Candidate version/channel and numeric `CFBundleVersion` policy (including prerelease mapping and rebuild uniqueness). Root `0.6.0` is audited state, not the beta assignment.                                                            | Identity generator and candidate creation            |
| D6  | #385/#388/#403 integrator | Review contract v1 field names, evidence retention and final shared-file ownership. Consumers can start with fixtures now.                                                                                                               | Parallel implementation touching manifests/workflows |

No new issue is needed for these owner decisions: they fit #385 and its existing testing,
upgrade and onboarding peers. Missing prerequisites must produce `blocked`/`unknown`
evidence, never fabricated publisher names, artifact hashes, Mac results or access grants.
