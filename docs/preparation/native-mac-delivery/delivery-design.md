# Native Mac delivery design

Proposed implementation for #385, based on the [audited source](current-state.md).
This document authorizes no signing, account changes, downloads to a person's Mac or
publication. External guidance was consulted **2026-10-02**; recheck it and the locked
builder APIs when implementation starts.

## Signing and packaging sequence

Use direct distribution with a **Developer ID Application** identity belonging to the
owner's confirmed Apple team. A development or ad-hoc signature is not an acceptable
substitute. Developer ID Installer/PKG and App Store distribution are outside this DMG/ZIP
plan. Apple describes the certificate and account requirements in
[Signing Mac Software with Developer ID](https://developer.apple.com/developer-id/).

The proposed signed arm64 lane has these ordered stages:

1. Resolve an approved immutable source SHA and root release version. Install from the
   frozen lockfile; record actual tool versions, runner architecture and OS. Reject a
   version override that differs from the root manifest. Build app and daemon once.
2. Write `Contents/Resources/orca-build.json` before signing, using the
   [artifact contract](artifact-contract.md). It binds source, workflow run and daemon
   bytes without a runtime/protocol API change. Confirm arm64 Mach-O contents.
3. Package an arm64 app directory and sign nested executables/frameworks/helpers and then
   the enclosing app with hardened runtime and secure timestamps. Use the builder's
   signing integration, explicit reviewed entitlements, and `forceCodeSigning` for this
   lane. Verify the actual Team ID and Developer ID chain, not just command success.
   This lane must never select `identity: null`, ad-hoc identity or unsigned fallback.
4. Archive the signed app temporarily with metadata-preserving macOS tooling. Submit it
   with `xcrun notarytool`; retain the submission ID, submitted archive SHA-256 and JSON
   result/log. Require `Accepted`, review warnings, then staple and validate the app.
5. Produce both distribution formats from that same stapled app. Recreate the final ZIP
   after app stapling; ZIP itself cannot carry a stapled ticket. Build and sign the DMG,
   submit the DMG separately, require `Accepted`, then staple and validate the DMG.
   Validate the app extracted from each final container, including its app ticket.
6. Generate final SHA-256/size records only after every signature, staple and archive
   transformation. Run the candidate verifier and #388 packaged checks against these
   exact files. Promote the tested bytes; never rebuild during promotion.

The separate app and DMG submissions are a deliberate ORCA policy to provide a stapled
app in both formats and container evidence for the DMG. They are not a claim that Apple
always requires two submissions for a simple disk image. Apple's
[custom notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
documents submission/status/log handling and the ZIP stapling limitation. The builder
must have one notarization owner: with this explicit `notarytool` sequence, disable its
automatic submission in the signed overlay to avoid duplicate submissions. A retained
`notarize: false` there would mean external notarization owns the step, never that it is
optional. Name and gate that distinction explicitly.

## Entitlements and tool-version gate

Start the review from `com.apple.security.cs.allow-jit` for the Electron main/renderer
executables that need V8, including Electron reused for the daemon. Do not add
`get-task-allow`, disable library validation, allow unsigned executable memory, or grant
Apple Events/device access without a demonstrated requirement. Ordinary external agent
processes are not in-process unsigned libraries. App Sandbox is a different policy from
hardened runtime; do not enable it as a notarization fix or weaken Chromium's sandbox.
Inspect the effective entitlement set on each helper as well as the main executable.
Electron's [notarize guidance](https://github.com/electron/notarize) describes `allow-jit`
and warns against the legacy unsigned-memory exception on modern Electron.

Preserve the existing `ELECTRON_RUN_AS_NODE` daemon launch. A generic hardening recipe
that disables the RunAsNode fuse would break this architecture. Test Finder launch and
the child process under the signed app; signature validation alone cannot prove that.
The [source audit](current-state.md) identifies the existing launch code, which remains
owned by the runtime/connection team.

The rolling builder docs now describe nested `mac.sign` options, while this repository's
configuration uses `mac.identity` and locks builder 26.15.3. A version-specific upstream
source fetch was unavailable during preparation. Do not copy rolling syntax into the
locked build blindly: resolve the installed schema, signing hooks, `--prepackaged` behavior
and entitlement defaults in the first implementation slice. Prove that constructing a
DMG/ZIP from a signed/stapled app does not re-sign or mutate its payload. Keep this as
decision D2 in [prerequisites](prerequisites.md), not an untested runnable YAML recipe.
References: [builder signing](https://www.electron.build/docs/features/code-signing/),
[current option source](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/options/macOptions.ts),
[Electron signing overview](https://www.electronjs.org/docs/latest/tutorial/code-signing).

## Invited-user delivery

Propose an authenticated HTTPS download area independent of repository access, extending
the trust separation in [UPDATING.md](../../../docs/UPDATING.md). The owner chooses the host
and identity provider (D3); no production hostname, account or access grant is assumed.
For the beta, prefer a browser sign-in session with an explicit invite allowlist and
revocable per-user access. This browser authentication layer is new work; the existing
Windows bearer-feed example does not implement it.

The trusted promotion job copies only the verified arm64 pair, manifest, checksums and
sanitized evidence to an immutable candidate directory. Use a separate deployment
credential scoped to that directory. The source repository's credential remains solely
in trusted CI; never copy source archives, private source URLs or GitHub tokens into the
download catalog, binaries, browser, renderer, metadata or URLs. Expose only the approved
public build identifier and source commit string. Invitation/access changes require
separate owner authorization.

Authenticate the catalog and every asset request, including HEAD, Range, evidence and
checksum files. Use an HttpOnly, Secure session cookie, enforce authorization at the
origin, prevent shared caching of authenticated responses, and do not redirect to an
unprotected origin. Do not put bearer credentials or signed access tokens in URLs or
logs. An unauthenticated, expired or revoked session must return an access error before
serving bytes. Interrupted download can retry/range-resume after reauthentication, but
the final complete file must match the manifest. Revocation prevents future downloads;
it cannot recall a copy already downloaded.

Promotion is atomic: upload a complete version/build directory, verify it, then switch
the invited catalog pointer. Missing files, failed tests or failed upload keep the prior
candidate selected. The Mac lane must not change the Windows stable/prerelease feed or
require Windows metadata to validate a Mac-only snapshot. `feed-r2.sh` currently
does require that metadata, so reuse its immutable/atomic pattern through a coordinated
extension or separate Mac publisher, not an unmodified invocation.

## Clean Mac path and evidence

The invited user signs in through the approved site, chooses the arm64 candidate,
downloads the DMG (ZIP remains an alternate), and sees the version and checksum matching
the manifest. On a clean Apple Silicon account, use a normal browser download that
preserves quarantine, open the DMG in Finder, copy `ORCA.app` to Applications and launch
it normally. Test ZIP extraction and launch separately. An ordinary macOS first-open
confirmation is acceptable; a security override, quarantine removal, disabled Gatekeeper
or disabled sandbox is a failure. Record online first launch and a fresh offline launch
after download to exercise stapled tickets. No earlier trust override may contaminate
the acceptance account.

The operator captures `codesign --verify --deep --strict`, displayed signature identity
and entitlements, `xcrun stapler validate` on the app and DMG, and Gatekeeper assessment
(`spctl --assess --type execute` for the app; disk-image assessment for the DMG). Use
current Xcode/macOS tools and retain their versions and statuses. A physical Finder
walkthrough remains required even if these commands pass. TCC prompts, workspace/tool
access, safe sample and actual bundled-daemon identity belong to #386/#388 and physical
acceptance; notarization grants none of those permissions. See Apple's
[notarization overview](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
and [issue resolution guidance](https://developer.apple.com/documentation/security/resolving-common-notarization-issues).
