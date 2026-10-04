# Credential-free signing foundation (#464)

Implemented from freshly fetched main
`94a02bd3f5421991f4a8b7a5c6f352151dc5fbbb`, then integrated with reviewed main
`b9b8807252e39c506c24b17ec0c637701e4a68d1`. This is an isolated producer and
locked-builder compatibility exercise for [#385](https://github.com/cschadewitz/Project_Orca/issues/385).
It does not satisfy signed delivery or [#388](https://github.com/cschadewitz/Project_Orca/issues/388)
packaged acceptance. Both parents stay open. #464 is registered as a native sub-issue of #385.

## Producer and input boundary

`packages/app/scripts/native-mac-identity.js` accepts **only `--mode fixture`**.
Missing mode and candidate/production/unsigned modes fail before reading inputs or
building. The ordinary packaging config, manifests, workflows, RunAsNode fuse and
runtime are untouched; `mac.identity: null`, `mac.notarize: false` and Windows
`dev.orca.desktop` remain intact. No overlay is activated.

The producer requires a clean selected full source SHA, checks tracked/index/untracked
changes, reads root version and `release-compatibility.json`, and hashes the complete
lockfile. Installed Electron, electron-builder, esbuild and TypeScript versions must
match the workspace lock document (pnpm 12 uses multiple YAML documents); the running
pnpm must match `packageManager`. Start with a frozen install. These checks are local
build provenance, not dependency attestation or a protected runner trust boundary.

It forces TypeScript compilation, uses the existing daemon bundler to create a fresh
bundle in a private temporary directory, and compares its bytes to the supplied staged
daemon and expected SHA-256. A stale or tampered staged bundle fails. It reads compiled
protocol in a new Node process and reuses `tools/probe-bundled-daemon.js` for authenticated
owned-child version/protocol checks. Source/lock and staged bytes are checked again
before output. No daemon/probe/protocol implementation is duplicated or modified.

Required metadata JSON (values below are synthetic examples, not production choices):

```json
{
  "kind": "fixture",
  "sourceCommit": "<full selected clean SHA>",
  "appVersion": "<exact selected root version>",
  "bundleId": "com.schadewitz.orca",
  "expectedTeamId": "Q2FP9UY5T4",
  "platform": "darwin",
  "arch": "arm64",
  "protocol": { "major": 2, "minor": 0 },
  "buildId": "gha:0:0:mac-arm64",
  "bundleShortVersion": "0.0.0",
  "bundleVersion": "0007.02",
  "xcode": "0.0.0",
  "macos": "0.0.0"
}
```

Replace source/version/protocol with selected source values; the producer rejects
mismatches. Plist strings are mandatory and preserved verbatim, including leading
zeros. It never derives D5's mapping. Build ID and native tool versions are explicit
synthetic inputs; Linux output is not represented as an observed Mac build. This
metadata is a fixture app/plist stand-in, **not inspection of a packaged app**.

From a clean committed checkout, after frozen install and the ordinary build/bundle:

```sh
pnpm run build
pnpm --filter @orca/app run build:daemon
node packages/app/scripts/native-mac-identity.js \
  --mode fixture --source-commit <full-sha> --metadata <synthetic-input.json> \
  --daemon packages/app/dist/daemon/orca-daemon.mjs \
  --daemon-sha256 <sha256-of-staged-daemon> --output <new-fixture-directory>
```

Keep input/output under ignored build storage or outside the checkout so they do not
make source dirty. The command requires local loopback for its synthetic daemon probe.
It does not install dependencies or download Electron. It writes a new directory only:

- `orca-build.json`: exactly the proposed delivery-v1 identity fields. No invented
  `kind`, team, lockfile or policy fields are added to that contract.
- `fixture-provenance.json`: a local, non-delivery receipt recording fixture kind,
  source/lock/identity hashes, public expected team, build tools, actual host and which
  fields are synthetic. It is not an artifact manifest or signing evidence.

Do not place this output into a signed candidate. The identity alone cannot prove its
own fixture status; candidate production is unimplemented and refused. A later native
adapter must inspect the actual package/plist/resources and approved runtime/toolchain,
bind protected workflow provenance, and verify the final signed resources. These local
checks assume a trusted, quiescent build workspace; they are not race-resistant against
a hostile concurrent writer. A failed write may leave an incomplete fixture directory;
there is no success receipt and no overwrite/retry promotion path.

## Locked builder findings and reproducible tests

Inspected installed `electron-builder` / `app-builder-lib` **26.15.3**,
`builder-util-runtime` **9.7.0**, `@electron/osx-sign` **1.3.3**, Electron **44.4.5**.
Paths below are within those exact installed packages, not assumptions from newer docs.
`tools/test/native-mac-builder.test.js` exercises real JavaScript APIs with inert paths:

| Finding | Source and test evidence |
| --- | --- |
| Top-level `afterPack`/`afterSign`, Mac explicit entitlements/hardened runtime and opaque plist version fields validate; unknown options fail. The unregistered `typeof` keyword in an `anyOf` branch accepts even numeric hooks unchanged, so schema acceptance is not hook execution proof. | `app-builder-lib/scheme.json`, `out/util/config/config.js:getConfig/validateConfiguration`, `schemaValidator.js`; tests load the ordinary config with inert overrides and demonstrate this permissive hook branch. |
| Overlay target and extra-resource arrays concatenate, retaining existing x64 targets and the daemon resource. Merely adding arm64 does not isolate a lane. | `builder-util-runtime/out/objects.js:assignKey`, builder `doMergeConfigs`; tested against actual ordinary config. |
| `afterPack` is after extra-resource copies and before framework post-pack, sanity, fuse flipping and signing. | `out/platformPackager.js:doPack` source inspection. Actual native hook ordering is not run here. |
| `afterSign` fires only when `signApp` returns true. A hook is not independent signature proof. | `out/platformPackager.js:doSignAfterPack`; both return paths exercised with mocked sign result. |
| Non-MAS `prepackaged` skips `doPack` entirely and goes to container targets. Identity insertion, fuses and app signing hooks cannot be relied on in that pass. MAS differs. | `out/macPackager.js:packMacTargets/packMasTargets`; tested doPack bypass and exact forwarded app path. No actual DMG/ZIP built. |
| Explicit null identity skips signing; combining it with force signing throws. | `out/mac/MacTargetHelper.js:handleNullIdentity`; both paths tested without identity discovery. |
| Non-MAS runtime hardening defaults true. Main and inherited code default to builder's `templates/entitlements.mac.plist`: allow-jit, allow-unsigned-executable-memory, disable-library-validation. Explicit paths override them; build-resource fallback paths also exist. Login helper has a separate option. | `MacTargetHelper.getOptionsForFile`; effective callback outputs/template keys tested. This is inspection, not approval of these entitlements. |
| Builder's defined per-file entitlements override osx-sign's role-specific defaults. Undefined login-helper options fall through to osx-sign defaults. Pre-auto entitlement handling is enabled unless false, but only automates when app-sandbox is enabled. | `@electron/osx-sign/dist/cjs/sign.js:defaultOptionsForFile/mergeOptionsForFile/signApplication`, `util-entitlements.js:preAutoEntitlements`. Source-inspected; no native signature or resulting entitlement verification. |

Run the focused suite:

```sh
pnpm exec vitest run tools/test/native-mac-identity.test.js \
  tools/test/native-mac-builder.test.js tools/test/desktop-identity.test.js \
  tools/test/bundled-daemon-probe.test.js
```

Producer negatives cover missing metadata/native values, dirty/staged/untracked or
wrong source, wrong app/daemon version and protocol, tampered/empty bytes or wrong hash,
old bundle/wrong team, x64, missing/number-coerced plist version, tool ranges, invalid
timestamp and fixture-as-candidate attempts. Mocked orchestration proves code paths,
not native behavior. Exact check outcomes and implementation SHA belong in the draft PR.

## Single-validator fixture integration and remaining gates

[#442](https://github.com/cschadewitz/Project_Orca/pull/442) merged into main at
`b9b8807252e39c506c24b17ec0c637701e4a68d1`. Its
`tools/deploy/native-mac-verify.py` remains the single manifest and synthetic-app
validator. The test-only `make_fixture.py` adapter accepts a producer output directory
and the exact staged daemon bytes, checks the local fixture receipt and hashes, copies
the frozen fixture, then replaces the synthetic identity, daemon, plist strings and
derived manifest/checksums. Container files and signing/notary/stapling declarations
remain synthetic stubs. The adapter does not assert that either container includes the
app and does not validate candidate artifacts.

After producing identity with the command above, exercise the shared validator:

```sh
python3 tools/deploy/tests/native-mac/make_fixture.py \
  --producer-output <new-fixture-directory> \
  --daemon packages/app/dist/daemon/orca-daemon.mjs \
  <new-synthetic-fixture-directory>
python3 tools/deploy/native-mac-verify.py --mode fixture \
  --fixture-app <new-synthetic-fixture-directory>/ORCA.app \
  <new-synthetic-fixture-directory>/delivery
```

`tools/test/native-mac-validator-integration.test.js` runs the producer's assembly
function through this adapter and the validator, including changed-identity, daemon
and plist negatives. The Python validator's 37 focused cases still cover malformed
manifests and candidate-mode refusal. The producer's public expected Team ID in its
separate local receipt is not an observed publisher or an addition to the sealed
identity/manifest schema. Windows separately retains `dev.orca.desktop`.

The next ordered work remains in #464/#385/#388 rather than duplicate issues:

1. Resolve publisher/certificate authority, D4 supported macOS, D5 version mapping and
   D6 ownership; verify protection availability, trusted source/workflow controls,
   environment, native runner and notary method. Missing inputs must continue to block.
2. With shared-config ownership and separate activation authorization, construct an
   explicit arm64 effective config, review minimal entitlements for Electron and
   RunAsNode daemon, insert/verify identity before signing, and prove native hooks.
   Do not use a concatenating overlay as an architecture restriction.
3. Separately verify signatures, expected team/certificate, final entitlements,
   hardened runtime, notarization/stapling, both extracted container copies and actual
   packaged execution. Prepackaged container creation must not mutate the accepted app.

No credentials, account/access/environment changes, active signing, workflow dispatch,
notarization, release, distribution or tester contact are part of this foundation.
Native Mac packaging, codesign, Gatekeeper, ticket verification and physical acceptance
are **not run**. The approved public IDs alone resolve none of those gates.
