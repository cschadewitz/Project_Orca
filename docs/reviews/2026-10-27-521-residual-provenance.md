# #521 residuals: embedded Magicast source map code and legacy `@electron/get`

This review is independent of any release candidate. It records the two
dependency residuals that remained open on
[#521](https://github.com/cschadewitz/Project_Orca/issues/521) after
[#698](https://github.com/cschadewitz/Project_Orca/pull/698) (Happy DOM 21.0.4),
[#714](https://github.com/cschadewitz/Project_Orca/pull/714) (updater 6.8.11) and
[#720](https://github.com/cschadewitz/Project_Orca/pull/720) (builder 26.18.0 / Vite 8.3.5)
merged. Those upgrades are not repeated here. It is a snapshot of one commit. It
does not verify a later candidate. Refresh it on the release commit using the
procedure at the end.

| | |
| --- | --- |
| Examined commit | main `4d5176c8d57c37f974517900935e6e28ea234082` |
| `pnpm-lock.yaml` blob | `4889f406d1b232f2e9959e95aa71154549214f46` |
| Toolchain | Node 24.21.0, pnpm 12.4.2, Linux x64 |
| Audit time | 2026-10-27T01:12:03Z |
| Advisory/registry check time | 2026-10-27T01:15:47Z |
| Evidence | [`evidence/521-residual-provenance/`](evidence/521-residual-provenance/), with exact commands in [`commands.txt`](evidence/521-residual-provenance/commands.txt) |

The lock, every `package.json`, `pnpm-workspace.yaml` and `electron-builder.yml` are
byte-identical to #720's merge `1538d34b02eeb6ecbfeeea1464dd26f6fab85b9b`. The 149
commits since then change source only. No dependency, lockfile, runtime, workflow or
configuration file was changed for this review.

## Current audit state

These were rerun fresh. Older advisory counts are not quoted.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` (existing lifecycle policy) | Passed |
| `pnpm audit --json` | 0 advisories; 549 dependencies |
| `pnpm audit --prod --json` | 0 advisories; 162 dependencies |
| `pnpm audit signatures` | 549/549 registry signatures verified |
| npm bulk advisory endpoint, installed versions | `{}` for source-map-js 1.2.2, http-cache-semantics 4.3.0, sprintf-js 1.1.3, magicast 0.5.5, @electron/get 3.1.0, got 11.8.6, global-agent 3.0.0, roarr 2.15.4, cacheable-request 7.0.4 |
| npm bulk endpoint, superseded versions (control) | Still returns GHSA-68fv-2mgg-jv7q for source-map-js 1.2.1 and GHSA-ch52-4w7c-c8xp for http-cache-semantics 4.2.0 |

Primary advisory pages as read on 2026-10-27:

- [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q): high,
  `>=1.0.0 <1.2.2`, patched 1.2.2, not withdrawn. The input is an indexed source map
  whose section offsets are unvalidated.
- [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp): high,
  `<=4.2.0`, no patched version listed, not withdrawn. It requires a shared HTTP cache
  and a client-supplied `max-stale`.
- [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) (sprintf-js):
  withdrawn 2026-10-22. Upstream says exception handling is the application's job. No
  patched version exists.

**A clean audit does not cover the embedded copy.** npm audit matches advisories by
package name and version. Code inlined into another package's bundle has no entry of
its own, so the bulk endpoint returns nothing for `magicast@0.5.5`, and the audit
reports zero while `source-map-js@1.2.1` code is installed.

The GitHub REST advisory API (`api.github.com/advisories/...`) was refused with HTTP
403, because this session is bound to repository-scoped endpoints. The public advisory
pages and npm's bulk endpoint were used instead. Nothing was done to get around the
refusal.

## Residual 1: Magicast 0.5.5 bundles `source-map-js@1.2.1`

**Version and source.** `magicast@0.5.5` is the only version installed. Its
`dist/builders-CDdrUKLb.js` (sha256 `6d589e4c…553c`) contains 10 `//#region` blocks
named `node_modules/.pnpm/source-map-js@1.2.1/…/lib/*.js`. The package's own
`inlinedDependencies` field records `source-map-js: 1.2.1` and `recast: 0.24.0`. The
dist never imports the external `source-map-js`: its only imports are `@babel/parser`
and `node:fs`. So the 1.2.2 resolution in the lock does not reach this code.

The embedded `IndexedSourceMapConsumer` has no `isValidOffset` check and no
`MAX_SECTION_OFFSET_LINE` limit, both of which 1.2.2 has. The bounded probe below
confirms the difference in behavior. The registry tarball matches the lock integrity
(`sha512-UicdXN8z…MvszA==`), and its extracted tree is identical to the installed copy.
Magicast's `latest` tag is still 0.5.5. Versions 0.5.3, 0.5.4 and 0.5.5 all inline
1.2.1, and 0.5.2 and earlier did not inline it. `@vitest/coverage-v8@5.0.5` requires
`magicast ^0.5.5`, so moving to an earlier version is not an option.

**Where it is used.** The dependency path is root devDependency
`@vitest/coverage-v8@5.0.5` → `magicast`. Its only caller is
`provider.parseConfigModule()`, which Vitest reaches only from `reportThresholds()`
when `coverage.thresholds.autoUpdate` is set. The installed `cli-api` chunk shows that
call runs `parseModule(config text)` and then `generate()` with no options.

**Attacker-controlled input needed.** An indexed source map passed as `inputSourceMap`
together with `sourceMapName` to `generateCode`/`writeFile`. Only then does recast's
`composeSourceMaps` build the embedded `SourceMapConsumer`. Parsing never consumes a
map.

**Actual reachability.**

- *Development and CI:* not reached. `autoUpdate` does not appear in `vitest.config.ts`,
  any package script or any workflow. Even with `autoUpdate` on, Vitest passes config
  text that the repository controls and passes no map.
- *Bounded probe:* the probe ran in-process with offsets of about 2×10⁷, which costs
  nothing to process ([`magicast-path-probe.txt`](evidence/521-residual-provenance/magicast-path-probe.txt), source [`magicast-path.mjs.txt`](evidence/521-residual-provenance/magicast-path.mjs.txt)).
  The Vitest-shaped `generate()` returns `map: null`. With both options opted in
  explicitly, the embedded consumer *accepts* an above-limit offset and a fractional
  offset, and 1.2.2 *rejects* both. This shows the validation gap. It does not
  reproduce the denial of service.
- *Shipped runtime:* absent. A fresh Linux package at this commit has no magicast,
  recast or source-map entries in `app.asar`. Marker strings such as
  `Section offsets must be ordered`, `IndexedSourceMapConsumer` and
  `SourceMapConsumer` appear nowhere in the extracted ASAR, the daemon resource, or the
  built main, preload, renderer and daemon output. Positive controls found the same
  markers in the dependency payloads
  ([`build-output-markers.txt`](evidence/521-residual-provenance/build-output-markers.txt),
  [`asar-markers.txt`](evidence/521-residual-provenance/asar-markers.txt)).

**Existing mitigation.** Threshold auto-update is off (the thresholds are hand-set
ratchets). Vitest's call supplies no map. Vite and PostCSS use the external 1.2.2.

**Confidence.** High for the inspected installed code and configuration, because both
the source and the behavior were checked. It would change if ORCA code started calling
magicast with input maps, or if a Vitest or coverage-v8 update changed the call.

**Disposition: deferred maintenance. Not a release blocker.** It is a development-only
validation gap that no ORCA input can reach.

**Smallest justified remediation.** None can be done in the lock: no override or
resolution changes inlined bytes. The fix is an upstream Magicast release that re-inlines
`source-map-js >=1.2.2`, picked up by the dependency owner through the normal
coverage-v8/magicast update. Do not patch or vendor `node_modules`. Until then, keep
`coverage.thresholds.autoUpdate` off, and do not add direct magicast use with
`inputSourceMap`.

**Provenance.** The npm SLSA v1 statement names `unjs/magicast`
`.github/workflows/release.yml` at `refs/tags/v0.5.5`, commit
`1804bf72b3e9cf6224a9e81ddd9771b074c41fdd`, run `34558631258`. Its subject sha512
equals the downloaded tarball's digest. One independent Sigstore verification attempt,
using npm's bundled client with the default trust root, failed with
`TUF_REFRESH_METADATA_ERROR` (HTTP 403) while refreshing the trusted root. That is the
same refusal #698 and #720 recorded. It was not retried, mirrored or bypassed
([`sigstore-attempt.txt`](evidence/521-residual-provenance/sigstore-attempt.txt)). **So
the statement is unverified, not disproven.** The failure is a trust-infrastructure
access gap. It is not evidence that the artifact is malicious. Registry signature and
integrity checks did pass.

## Residual 2: the legacy packaging closure under `@electron/get@3.1.0`

**Version and source.** `app-builder-lib@26.18.0` requires `@electron/get ^3.0.0`,
which resolves to 3.1.0 (published 2024-07-15, the last 3.x release, by `electron-cfa`;
it has no npm attestation). Its closure is `got@11.8.6` → `cacheable-request@7.0.4` →
`http-cache-semantics@4.3.0`, plus the optional `global-agent@3.0.0` → `roarr@2.15.4` →
`sprintf-js@1.1.3`. All are reached only through `electron-builder`, an `@orca/app`
devDependency.

`electron@44.9.1` separately uses `@electron/get@5.1.0` for its postinstall download.
The 3.1.0 tarball matches the lock integrity and is identical to the installed copy.

Upstream state on 2026-10-27: `app-builder-lib` `latest` is 26.18.0, and `v26` is
26.18.1 (2026-10-26). Both still require `^3.0.0`. Only `next` 27.0.0-alpha.13 moves to
`@electron/get ^5.1.0`, and it needs Node `>=22.12.0`.

**Where it is used.** Only for packaging: `.github/workflows/desktop.yml` (manual
dispatch, or `workflow_call` from `release-publish.yml`; pull requests do not package),
on the self-hosted homelab Linux runner, `macos-latest` and `windows-latest`, and on a
developer's local `pnpm --filter @orca/app run package`. app-builder-lib fetches two
things through it:

- the Electron zip, when `electronDist` is unset, which is the release default;
- builder toolsets: 7-Zip, NSIS, winCodeSign, AppImage and others.

**Attacker-controlled inputs.** Three sources feed this path:

- Network responses from the GitHub release hosts, or from a mirror if
  `ELECTRON_MIRROR` or `electronDownload` is configured. Neither is configured in ORCA.
- Persistent cache contents: `~/.cache/electron` and `~/.cache/electron-builder`. The
  workflow restores these with `actions/cache`, keyed by the lock hash with a prefix
  fallback, and the self-hosted runner keeps them between jobs anyway.
- The packaging environment.

**Actual reachability and behavior.** A real `electron-builder --linux dir --x64
--publish never` run at this commit, with no `electronDist` and caches redirected to
scratch, exercised the release-default path
([`package-linux-dir.txt`](evidence/521-residual-provenance/package-linux-dir.txt)):

- **Download integrity.** `@electron/get` 3.1.0 downloaded the Electron zip, then
  fetched `SHASUMS256.txt` from the same release with the cache bypassed, and
  sumchecker accepted the zip. A cache hit is re-validated the same way. So the Electron
  zip is trusted by origin over TLS, with no signature. In this run the zip it fetched
  had the same sha256 as the one pinned in `electron@44.9.1`'s `checksums.json`
  ([`package-digests.txt`](evidence/521-residual-provenance/package-digests.txt)).
  Builder toolsets are checked
  against digests pinned in app-builder-lib (sha256 by @electron/get, sha512 by the
  builder).
- **Cache trust assumption.** app-builder-lib also takes inline checksums from a
  `SHASUMS256.txt-<version>` file in the cache root if one exists. Anyone who can write
  to a persistent runner cache could therefore supply both the archive and its expected
  digest. Nothing inspected writes that file: not ORCA, not app-builder-lib, and not
  @electron/get. This review did not inspect
  the runner hosts. It is an assumption to keep true, not an observed problem.
- **http-cache-semantics: not reached.** `got` builds `cacheable-request` only when
  `options.cache` is set. Neither app-builder-lib nor GotDownloader sets it; the logged
  options are a timeout and a proxy agent. The installed 4.3.0 is also outside the
  advisory's range.
- **global-agent → roarr → sprintf-js: environment-dependent.** `@electron/get`
  bootstraps global-agent when the module loads, but only if `ELECTRON_GET_USE_PROXY` is
  set. **This sandbox sets it**, so the path really was loaded during the probe. ORCA's
  own workflows do not set it, and the runners' environments were not inspected. Even
  when loaded, roarr calls `sprintf` only when `ROARR_LOG` is truthy; it was unset here.
  global-agent's messages are fixed strings. Requests went through the builder's
  explicit `HttpsProxyAgent`. That advisory has also been withdrawn.
- **Shipped runtime: absent.** The fresh `app.asar` (1,618 entries) holds 24 production
  packages, the same set #720 recorded, with no nested manifests. It contains no got,
  global-agent, roarr, sprintf-js, http-cache-semantics, cacheable-request,
  `@electron/get` or builder entries, and no `.map`, `.d.ts` or `.tsbuildinfo` files.
  `resources/daemon/orca-daemon.mjs` matches the build byte for byte (sha256
  `675e071f…6987`, [`package-digests.txt`](evidence/521-residual-provenance/package-digests.txt)). What this code path leaves in the artifact is the Electron runtime
  it downloads, so its download integrity is what matters for shipped bytes.

**Existing mitigation.**

- No packaging on pull requests.
- A pinned lock and verified registry signatures.
- Checksum validation is not disabled (no `isVerifyChecksum: false` or
  `strictSSL: false` in `electron-builder.yml`).
- Toolset digests are pinned upstream.
- The packaged closure is checked (#720 and this run).

**Confidence.** High for the installed code paths and the Linux release-default
behavior that was observed. Medium for the CI runners, whose environment and cache
contents were not observed. macOS and Windows toolset paths were not run.

**Disposition: conditional risk (build-time supply chain). Not a release blocker. The
major-version migration is deferred maintenance.** It becomes release-relevant only if
a packaging environment sets `ELECTRON_GET_USE_PROXY` together with `ROARR_LOG`, a
mirror, or `ELECTRON_DOWNLOAD_CACHE_MODE`, or if persistent caches can be written by
someone other than trusted jobs.

**Smallest justified remediation.** Nothing in range fixes this, and a forced
`@electron/get` major override is not recommended. For the dependency owner: adopt
app-builder-lib 27 once it is stable, as its own reviewed migration. For the workflow
owner, an optional change with no dependency involved: pass `electronDist` from the
installed `electron` package. Its postinstall (`@electron/get@5.1.0`) checks the zip
against the sha256 pinned in `electron/checksums.json`; this review confirmed
`994bc366…45e2` for the Linux x64 zip. That would take the Electron download off the 3.x
path, while toolset downloads would still use it. Until then:

- keep `ROARR_LOG` and any mirror variables unset in packaging jobs;
- keep runner caches limited to trusted jobs.

## Unknowns and limits

- The CI runners' real environment variables and persistent cache contents were not
  observed. The self-hosted runner was not accessed.
- macOS and Windows packaging, toolset downloads, signing and installers were not run.
  No published release asset was downloaded or inspected.
- No independent cryptographic SLSA verification was obtained (Sigstore TUF 403).
  `@electron/get@3.1.0` has no provenance statement at all. Its provenance here rests
  on the registry signature and lock integrity alone.
- The GitHub REST advisory API was denied. Advisory state comes from the public pages
  and npm's bulk endpoint as of 01:15Z.
- Tests and coverage were not run, because nothing executable changed. The Electron
  app was not launched.
- The default `node` on this container's PATH is 22.22.0, below the repository's
  `>=24` requirement. Every command here used Node 24.21.0, which matches CI.

## Refreshing on a release commit

On the exact release commit, re-pin the SHA and lock blob, then:

1. Rerun a frozen install, `pnpm audit --json`, `pnpm audit --prod --json` and
   `pnpm audit signatures`.
2. Rerun `pnpm why -r magicast @electron/get`.
3. Check `magicast`'s `inlinedDependencies`, its `//#region` names and its
   `IndexedSourceMapConsumer` checks, plus app-builder-lib's `@electron/get` range.
4. Rerun the `magicast-path.mjs.txt` probe, and grep the config, scripts and workflows for
   `autoUpdate`.
5. Package with the release-default `electron-builder` invocation, then inspect
   `app.asar` and the daemon resource with the marker scan and the positive controls.
6. Retry independent Sigstore verification only where the trust root is reachable.
   Record a failure as unverified.

If any of these results differ, this snapshot no longer applies.
