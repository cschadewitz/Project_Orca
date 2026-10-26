# Isolated builder/Vite validation (#639)

Candidate base is main `7627b2e7606f0deec6e29e67919ae09837190f73`, after
parent integration of updater successor #714. The exact current Dependabot
[#639](https://github.com/cschadewitz/Project_Orca/pull/639) head was re-fetched:
`93ad06992ae6d12aa9012ecc75d68cbbfbf7ee6d`, with base
`32f92cc16b9faf1748059e930c3f77b3934151ae`. Its complete two-file patch was
applied with Git's three-way merge to fresh main. Neither the older base nor
its updater 6.8.9 context was restored. The original remains open until its
reviewed successor merges; merging and supersession belong to the parent.

One dependency/lockfile owner performed this work, after #714 integration.
Current repository instructions and packaging/dev workflows were inspected.
There were no applicable `.agents/skills` files. Node 24.19.0 and pinned
pnpm 12.4.2 were used on Linux x64; CI's Node 24.21.0 was not reproduced.
No application runtime source, package-manager lifecycle policy, signing,
sandbox, coverage threshold or native hook was changed. No release, publish,
deployment, user-machine install, actual update, user credential, key/access
provisioning, upstream communication or homelab dispatch was performed.

## Complete graph and upstream scope

The first pnpm lock document is byte-identical to main. The second adds and
removes exactly the following nine package versions; all shared package
metadata is unchanged. Peer-key substitutions propagate the selected Vite
version through Vitest and the React plugin. Updater 6.8.11, Happy DOM 21.0.4,
all unrelated pins, and `pnpm-workspace.yaml` are retained. See
`evidence/639-builder-vite/lock-invariants.json`.

| Package | Baseline | Candidate |
| --- | --- | --- |
| electron-builder | 26.15.3 | 26.18.0 |
| app-builder-lib | 26.15.3 | 26.18.0 |
| dmg-builder | 26.15.3 | 26.18.0 |
| electron-builder-squirrel-windows | 26.15.3 | 26.18.0 |
| electron-publish | 26.15.3 | 26.18.0 |
| builder-util | 26.15.3 | 26.16.0 |
| @electron/rebuild | 4.2.0 | 4.2.1 |
| @noble/hashes | 2.4.0 | 1.8.0 |
| vite | 8.3.4 | 8.3.5 |

The complete [builder tag comparison](https://github.com/electron-userland/electron-builder/compare/electron-builder@26.15.3...electron-builder@26.18.0)
contains 66 commits/184 files, including the intermediate releases, and the
[Vite comparison](https://github.com/vitejs/vite/compare/v8.3.4...v8.3.5)
contains 54 commits/175 files. Review included changed production graph,
distributed JavaScript and applicable source paths, not just the final
release's notes. Relevant changes include:

- pnpm workspace discovery, hoisted/isolated layout detection, repeated-child
  stub recovery, declared-range resolution, app/dependency name collisions,
  cycle handling and collector fallback/error reporting. Builder v26's
  missing-production-dependency default remains **warn-only**; a successful
  package command alone is insufficient closure proof.
- ASAR workspace component boundaries and mapped file destinations;
  platform symlink policy; Mac locale/license retention; NSIS payload format,
  install-time decoder filters, per-target package caches and elevate staging;
  stored-ASAR regions and finer blockmaps. ORCA does not opt into the new
  `store-asar` mode. ASAR's existing explicit system-path denylist and
  home/temp allowances remain; it does not reject every external path.
- Builder toolset archive/cache checksum handling and containment, offline
  Electron checksum configuration, platform archive/toolset changes and
  signing/logging fixes. Signing, installer compiler, AppImage, Snap, Flatpak,
  AppX/MSI, Squirrel, GitLab publishing and Mac-native branches were not
  executed by the Linux package probe.
- Vite's preload/import-map hashing, asset/base resolution, CSS URLs,
  optimizer and module/HMR changes. Vite's package graph otherwise remains
  locked to the existing transitive versions in this candidate.

Noble 1.8.0 is an upstream compatibility choice with the corresponding
`@noble/hashes/blake2.js` import correction. An independently generated
CPython BLAKE2b-144 known answer passes through the real builder blockmap
API. The version downgrade alone is not treated as a vulnerability claim.
Rebuild 4.2.1's Node >=22.12 floor fits the selected Node runtime.

## Real Linux package and production closure

After the ordinary build and `build:daemon`, the existing supported builder
CLI produced an unsigned Linux x64 tarball using the repository's unmodified
`electron-builder.yml`, with only local Electron-distribution/output-directory
arguments and `--publish never`. No rebuild or packaging hooks were disabled.
The pinned Electron 44.9.1 binary was downloaded by its standard install
script; the builder fetched its standard 7-Zip 1.0.0 toolset. Both downloaded
archives were independently SHA-256 rehashed against their pinned package
checksum presets. Those values are retained in `binary-download-integrity.json`.

Local artifacts are under `/tmp/orca639/package/`: the unpacked image and
`ORCA-0.1.0-linux-x64.tar.gz`. They are validation artifacts, not published
release assets; the app manifest's ordinary 0.1.0 package version is retained.

The real pnpm collector ran against the actual installed workspace. The ASAR
contains **1,606 entries and 24 production package versions**. An independent
manifest walk resolves **29 dependency edges** from the app and verifies each
resolved version exists in the actual ASAR, rather than trusting builder's
nonfatal warning policy. This includes `jsonfile`, `graceful-fs`, updater
6.8.11 and the workspace core/protocol/design closure. The only collection
diagnostic was a duplicate workspace reference; no missing dependency was
reported. See `production-closure.json` and `asar-contents.txt`.

The inspection found no Vite/Vitest/Happy DOM/electron-builder/TypeScript
development packages, `.map`, `.d.ts`, `.tsbuildinfo`, or nested daemon/release/
diagnostics-native build directories in ASAR. Main, preload, bridge and
renderer entrypoints exist. The external daemon resource matches the built
bundle byte for byte; ASAR renderer HTML matches the built HTML. Eight built
renderer fonts and the design package's eight originals are present. Linux
has no native addon entries in this configuration; this does not prove
Windows/Mac native closure.

All 24 production packages also cold-import successfully from an extracted
copy of this ASAR under Node 24. This exercises packaged exports and runtime
module resolution; it does not launch Electron main/renderer or instantiate
an updater. See `production-imports.json`.

Python independently parsed the 79-entry tarball, checked all member/link
paths for containment, and compared ASAR, daemon and executable bytes with
the unpacked image. The tarball digest and critical member hashes/modes are
retained in `archive-inspection.json`. The authenticated standalone bundled
daemon probe passed with ORCA 0.6.0/protocol 2.0; it used an owned disposable
workspace and no provider. The packaged Electron UI was not launched.

## Real library archive/blockmap and resource checks

Seven new installed-builder unit cases cover ASAR workspace/prefix checks,
mapped destinations, explicit strict versus v26 default missing-dependency
behavior, archive platform policy and NSIS-decodable filter, independent
BLAKE2b-144 output, SHA-512 and fine/invalid blockmap regions, embedded raw
deflate map parsing and full-file hash, and pnpm deduped-child recovery with
and without an app/dependency name collision. The pnpm cases substitute only
command output/version, using owned on-disk package manifests and real
parsing, lookup, fallback and hoisting. The Linux package separately used
the real pnpm command and actual graph.

The 16 existing native resource-copy/hook tests pass under the new builder.
They exercise actual builder configuration and copying plus current
beforePack/afterPack fail-closed checks for missing/stale/wrong-architecture
resources. Their Mach-O/PE headers are synthetic; no native addon, Keychain,
Windows loader or signing success is implied.

The existing seven-case native Mac builder API suite also retains its hook,
entitlement, refusal and prepackaged-path assertions. Its explicit reviewed
`app-builder-lib` version expectation is updated from 26.15.3 to 26.18.0.
The first full-suite run caught that stale pin; it is a test compatibility
update, without changed signing or native behavior.

A separate manual probe used the real `NsisTarget.buildAppPackage`,
`WebInstallerTarget`, 7-Zip archiver and blockmap code with inert synthetic
executable bytes and a copy of the real packaged ASAR. It built default 7z,
explicit nondifferential ZIP, `useZip` plus differential (correctly 7z),
stored-ASAR 7z and a web payload with an embedded blockmap. All returned
SHA-512 values match independent hashes. The stored member is byte-identical
to packaged ASAR and its region is found in the actual archive. Python
independently decoded the web payload's appended map/length and checked its
covered byte count. It also recomputed every external stored-ASAR and
embedded web block checksum with `hashlib.blake2b(digest_size=18)`, separately
from the builder's Noble implementation. No NSIS compiler, signing operation
or installer ran.

The real archiver also created a Mac-like framework ZIP on Linux. Python's
ZIP parser verified that `Versions/Current -> A` and
`Owned -> Versions/Current/Owned` retain symlink metadata and relative
targets. Native macOS/NFD/codesigning behavior remains untested. Exact
commands/probe sources and results are retained with the evidence. Fixture
development corrected invocation details (library initialization, pnpm's
`dedupedDependenciesCount`, raw deflate and production `NODE_ENV`); final
results below use the corrected fixtures without product changes.

## Vite renderer evidence and browser blocker

Two new tests use the real Vite API with ORCA's actual renderer config/plugins.
The production build uses `NODE_ENV=production` just like the real build
command, preserving main/preload output while building into an owned temp
directory. It checks the exact production CSP, absent active crossorigin/dev
attributes, relative script/CSS paths resolving to existing `file:` assets,
eight external WOFF2 faces, source maps/content, and absent preview/type-proof
chunks. HTML comments are excluded from attribute checks because they
document dev-only `unsafe-inline`; the live CSP meta value is checked exactly.

The dev fixture uses the same plugins with an owned self-accepting module:
served HTML receives the dev-only CSP and Vite client, disk HTML is unchanged,
and a real filesystem change causes a real websocket HMR update followed by
fresh transformed module bytes. This proves build output, asset structure and
HMR transport; it does not prove browser HMR application or Electron layout.

**Browser blocker:** a sandbox-enabled Playwright launch of the installed
`/usr/bin/chromium` aborted because `/usr/lib/chromium/chrome-sandbox` is not
configured as its required root-owned mode 4755. Crashpad also reported its
unavailable database path. No sandbox-disable flag, SUID change, apt install,
privilege escalation or alternate access was attempted. Real `file://` browser
rendering/font loading/CSP enforcement and Electron App smoke remain unproven
here. The existing Electron path also lacks an X server/Xvfb. No new homelab
or platform workflow was dispatched; parent coordinates native acceptance.

## Supply chain and retained limits

Both fresh full and production-only audits report zero advisories before
and after (549 and 162 total dependencies respectively). No ignores, fixes
or unsupported overrides were applied. All 549 registry signatures verify.
For all nine changed packages, both baseline/candidate tarballs were fetched
from npm's registry, SHA-512/SHA-1 rehashed, registry signatures verified and
candidate integrity compared with the lock. All 1,004 candidate distributed
files match their installed counterparts. Package scripts/engines/dependencies and
available digest-matching SLSA statements are recorded in
`payload-integrity.json`.

Statement/digest comparisons are not independent cryptographic SLSA proof.
The inherited trusted-root refresh HTTP 403 remains; its denied endpoint was
not retried, mirrored or bypassed. #521's Magicast 0.5.5 embedded
`source-map-js@1.2.1` residual also remains; its external 1.2.2 resolution and
prior scope/payload finding are unchanged, without a fresh Magicast rehash.
Builder still uses `@electron/get@3.1.0`; clean current audits do not clear
historical packaging/proxy or embedded-code residuals. See the
[prior assessment](https://github.com/cschadewitz/Project_Orca/issues/521#issuecomment-6405046994)
and [updater review](2026-10-26-electron-updater-6.8.11.md).

## Validation

All checks below passed against the final executable/package/lock content.
Later edits only recorded prose and evidence. Raw responses and probe sources
are retained under `evidence/639-builder-vite/`, with SHA-256 checksums in
`evidence-manifest.json` and structured results in `validation-summary.json`.

| Check | Result |
| --- | --- |
| Baseline/candidate frozen installs | Passed; 534 lock entries checked under the unchanged lifecycle policy. |
| Types, lint, format, build | Passed; existing renderer chunk-size warning remains. The changed explicit version assertion also passed targeted lint/format checks. |
| Daemon bundle and authenticated bundle probe | Passed. |
| Linux x64 packaging and independent ASAR/tar/production-import probes | Passed; 24 production package versions, 29 dependency edges, all 24 cold imports. |
| New builder/Vite plus existing Mac builder/resource-copy focused cases | 32 passed, no skips. |
| Final full coverage, `VITEST_MAX_WORKERS=1 ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm run test:coverage` | 515 files passed, 5 skipped; 8,010 tests passed, 36 skipped, 1 todo; zero failures. All unchanged global/app/renderer thresholds passed. |
| Coverage | Statements 91.26%, branches 85.34%, functions 93.26%, lines 93.82%. |
| Explicit retry integration | Both CLI/ACP cases passed separately with `ORCA_RETRY_INTEGRATION=1`, two workers, no skips. |
| Compiled CLI demo | Passed with a scripted disposable workspace, then removed it. |
| Audits/signatures/payloads | Zero advisories before/after, 549 verified registry signatures; all changed payload digests/signatures and candidate installed bytes verified. |
| Lock invariants, `git diff --check`, Markdown/evidence checks | Passed. |

The initial two-worker suite failed only the stale explicit 26.15.3 test pin,
which was updated to 26.18.0. The next two-worker suite passed 8,009 tests but
hit `listen EADDRINUSE` at `127.0.0.1:35354` in an unchanged fixed-path recovery
fixture. That file passed all 19 cases when run alone. The final one-worker
suite passed every case without fixture/assertion/runtime changes. The failed
listen establishes port unavailability; the competing listener was not
identified. The one-worker invocation avoided concurrent file scheduling.
The prior failures are retained in `initial-suite-summary.json` and
`parallel-suite-summary.json`. No timeout, threshold or test skip was added.

Existing full-suite skips/todo are enumerated in `validation-summary.json`;
the two default-skipped retry cases were explicitly exercised. Native/browser
limits remain as described above. Required GitHub CI is a separate exact-head
result to inspect after publishing the successor draft. This evidence does
not approve a release or native installation.
