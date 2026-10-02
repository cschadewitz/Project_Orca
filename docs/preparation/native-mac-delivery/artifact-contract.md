# Apple Silicon artifact contract v1 (proposed)

Preparation interface for [#385](https://github.com/cschadewitz/Project_Orca/issues/385)
and [#388](https://github.com/cschadewitz/Project_Orca/issues/388), including
[#403](https://github.com/cschadewitz/Project_Orca/issues/403) fixture design.
Based on [source commit and audit](current-state.md), dated 2026-10-02.
This is a stable proposal for consumers, not a claim these manifests or artifacts exist.
Review changes with those owners before implementing; incompatible shape changes require
a new `schemaVersion`. No peer branch import is necessary to design fixtures.

## Required delivered files

For release version `V` (root SemVer, without a leading `v`), one immutable candidate
directory contains exactly these required top-level files plus referenced evidence:

| File                       | Contract                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ORCA-V-mac-arm64.dmg`     | Signed, notarized, stapled disk image containing `ORCA.app` with its own valid signature and stapled ticket. Primary user install path.                                              |
| `ORCA-V-mac-arm64.zip`     | Metadata-preserving archive with `ORCA.app` at its root, signed and stapled before archiving. No claim of a ZIP signature or ZIP staple.                                             |
| `native-mac-artifact.json` | UTF-8 JSON manifest described below; no tokens, private paths, source URLs or personal data.                                                                                         |
| `SHA256SUMS`               | Lowercase SHA-256, two spaces, relative filename, newline per entry; sorted filenames. Covers the two final containers, the manifest and referenced evidence files, but not itself.  |
| `evidence/*`               | Sanitized machine-readable verification/notary records and bounded text reports, each listed with digest/size in the manifest. No credentials/keychain or personal project contents. |

The filename convention retains [electron-builder.yml](../../../packages/app/electron-builder.yml).
The arm64 pair is not universal, Intel or Rosetta proof. Existing x64/Windows/Linux
outputs stay in their own contracts. A standalone `orca-daemon-V.mjs` is not required
in this Mac download set; if included by the general release, its bytes must match the
bundled daemon digest or the mismatch must block promotion. Never infer that Linux-built
and Mac-built daemon bundles are byte-identical merely because they share a source SHA.

Paths in this contract use `/`, are relative, contain no `..`, leading slash or symlink
escape, and are unique. Reject duplicate JSON keys and duplicate artifact/evidence paths.
SHA-256 strings are 64 lowercase hex characters; byte counts are positive integers.
Timestamps are UTC RFC3339 strings. Do not hash a mutable directory representation.

## Identity sealed inside the app

Proposed `ORCA.app/Contents/Resources/orca-build.json` is generated **before signing**.
All its fields below are required for a candidate, non-null and immutable:

| Field                                 | Type / semantics                                                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                       | Integer `1`.                                                                                                                                                                                                                        |
| `releaseVersion`                      | Exact root SemVer; equals packaged app metadata version and authenticated `hello.orcaVersion`.                                                                                                                                      |
| `bundleId`                            | String `dev.orca.desktop` unless D1 explicitly changes it before implementation; equals `CFBundleIdentifier`.                                                                                                                       |
| `platform`, `arch`                    | Strings `darwin`, `arm64`.                                                                                                                                                                                                          |
| `sourceCommit`                        | Full 40-character lowercase Git SHA of the clean checked-out source. No mutable branch name.                                                                                                                                        |
| `buildId`                             | String `gha:RUN_ID:RUN_ATTEMPT:mac-arm64`; decimal run/attempt from the producing workflow. A rebuild has a new attempt or run and is a new candidate. Controlled non-GitHub builders need a separately versioned/agreed ID format. |
| `builtAt`                             | Build identity creation timestamp. Informational, not reproducibility proof.                                                                                                                                                        |
| `appVersion`                          | Exact `app.getVersion()` / packaged app package version; must equal `releaseVersion`.                                                                                                                                               |
| `bundleShortVersion`, `bundleVersion` | Exact strings stamped into `CFBundleShortVersionString` and `CFBundleVersion`. Policy D5 must define their mapping before implementation; consumers compare them verbatim, never guess from SemVer.                                 |
| `daemon`                              | Object `{ "path": "daemon/orca-daemon.mjs", "sha256": string, "version": string }`; path relative to Resources, digest of actual shipped bytes, version equals `releaseVersion`.                                                    |
| `protocol`                            | Object `{ "major": nonnegative integer, "minor": nonnegative integer }` from compiled `@orca/protocol`; compare with authenticated local daemon `hello.protocol`. Not the package version.                                          |
| `storeEpoch`                          | String copied from the source's `release-compatibility.json`; compatibility information, not permission to roll back data.                                                                                                          |
| `toolchain`                           | Object of exact version strings: `electron`, `electronBuilder`, `node`, `pnpm`, `xcode`, `macos`; resolved versions, not package ranges.                                                                                            |

Compare the same fields against the final app plist, package metadata, daemon bytes and
runtime results. Manifest declarations alone are insufficient. The audited runtime's
`hello` has no source SHA: source identity is established by the verified app resource,
verified daemon bytes and the test's process/resource association, not an invented hello
field. Runtime identity additions from pending #397 must be reviewed with its owner;
this contract does not require modifying protocol or connection code.

## External manifest

| Field            | Type / candidate requirement                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`  | Integer `1`.                                                                                                                                                                                                                                                                                                        |
| `kind`           | `candidate` for a real verified build, `fixture` for synthetic consumer input. A fixture can never be promoted or counted as signing/launch evidence.                                                                                                                                                               |
| `identity`       | Exact parsed object from the signed `orca-build.json`.                                                                                                                                                                                                                                                              |
| `identitySha256` | Digest of the in-app identity file bytes; no JSON reserialization before hashing.                                                                                                                                                                                                                                   |
| `artifacts`      | Array of exactly two `{format, path, sha256, bytes}` records, `format` is `dmg` or `zip`; filenames obey the table above. Digests cover final post-stapling files.                                                                                                                                                  |
| `minimumMacOS`   | Non-empty version string approved under D4, equal to app `LSMinimumSystemVersion`; testing must establish support, not merely read a plist.                                                                                                                                                                         |
| `signing`        | Object `{teamId, certificateSha256, authority, hardenedRuntime, verification, reportPath}`. Approved public identity values, runtime flag `true`, verification `passed`. `reportPath` references a listed report of all nested code, timestamps and entitlement results. Reject ad-hoc or unexpected team/identity. |
| `notarization`   | Object `{app, dmg}`; each has `{submissionId, submittedSha256, status, logPath}`. UUID submission IDs, actual submitted bytes' digests, status exactly `Accepted`, logs referenced in evidence.                                                                                                                     |
| `stapling`       | Object with `appInDmg`, `appInZip`, `dmg`, each `{status, reportPath}`; status `passed` and report refers to validation of that extracted final item. ZIP-container staple is intentionally absent.                                                                                                                 |
| `evidence`       | Array of `{path, sha256, bytes}` for every referenced report; relative paths under `evidence/`. Sanitized notary log includes submission ID, status, submitted digest and any issue severity/path/message, with build-private paths removed.                                                                        |

Apple submission digests may differ from final artifact digests: app submission is a
temporary ZIP, rebuilt after app stapling; DMG changes on stapling too. Preserve both
digests and their stage names. Never compare a pre-stapling submission hash as if it were
the delivered file's hash. Notary acceptance is distinct from signature verification,
ticket validation, Gatekeeper assessment and packaged execution.

The manifest does not contain its own digest; `SHA256SUMS` binds it and the evidence.
Deliver both through the authenticated, trusted catalog, and keep the final manifest
digest in trusted CI/promotion records. Checksums detect corruption; an attacker able to
replace both files can recompute them. Publisher signature/expected team, controlled CI
provenance and protected distribution are independent requirements. This proposal does
not claim detached signing of the manifest.

## Consumer behavior and fixtures

Consumer order: authenticate download → enforce safe manifest shape and `kind` → verify
checksums/sizes → extract into isolated paths → verify app/container signatures and
tickets → read/compare sealed identity and daemon bytes → launch actual arm64 app →
authenticated bundled-daemon checks. Report distinct blocked/failed stages rather than
one ambiguous “verified” flag. Retain test results separately, bound to `buildId` and
artifact SHA-256, so adding a test result never mutates the signed app or final manifest.

For shape-only fixtures, use `kind: fixture` with synthetic, clearly labelled identity
and digests. The following is intentionally an **incomplete negative fixture**, not a
valid candidate or a test pass. `null` means unknown; validators must reject it for
candidate mode. Complete synthetic fixtures can exercise parsing but cannot satisfy
Mac, Apple or authenticated delivery gates.

```json
{
  "schemaVersion": 1,
  "kind": "fixture",
  "identity": null,
  "identitySha256": null,
  "artifacts": [],
  "minimumMacOS": null,
  "signing": null,
  "notarization": null,
  "stapling": null,
  "evidence": []
}
```

#403/#388 can independently design cases for missing pair, x64 masquerading as arm64,
wrong version/protocol/team, modified daemon, pre-staple hash, absent/invalid app ticket
in ZIP, rejected/timed-out notary response, missing evidence, unsafe paths, unknown schema,
fixture presented as candidate and revoked download access. Actual macOS executables
must be inspected and executed natively; filename assertions do not establish architecture.

D1 (publisher), D4 (macOS floor), D5 (version mapping) and D6 (review/ownership) remain
explicit decisions in [prerequisites](prerequisites.md). No real version, Team ID, ticket,
artifact digest, hardware result or download destination has been fabricated here.
