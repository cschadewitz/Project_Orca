# Isolated electron-updater 6.8.11 validation (#638)

Candidate based on main `32f92cc16b9faf1748059e930c3f77b3934151ae`, with
Node 24.19.0 and pinned pnpm 12.4.2 on Linux x64. Repository `AGENTS.md`
and `docs/DEVELOPMENT.md` were read; no applicable `.agents/skills` files
were present. The supplied pnpm 11.19.0 and installed dependency graph
were stale; baseline and candidate validation used frozen installs with
pnpm 12.4.2. CI's Node 24.21.0 was not reproduced locally.

The exact original heads and complete diffs were re-read:

- [#638](https://github.com/cschadewitz/Project_Orca/pull/638):
  `510c28bcec986937ec8830d6a4c1b781472bbf7d`, based on
  `0f45181c52dfc4bf1edd0e4469ff688dedef9189`. Only its updater patch was
  applied to current main; none of its older baseline was restored.
- [#639](https://github.com/cschadewitz/Project_Orca/pull/639):
  `93ad06992ae6d12aa9012ecc75d68cbbfbf7ee6d`, already based on the pinned
  main. Its builder/Vite changes are excluded. That work waits for parent
  integration of this candidate, with the same sole lockfile owner.

This is a successor to #638; keep the original open until the replacement
is merged. No merge, release, deployment, real install/update, private feed,
user credential, key provisioning or upstream communication is included.
No App smoke or homelab workflow was dispatched.

## Dependency and recovery invariants

The app's `electron-updater` range changes from `^6.8.9` to `^6.8.11` and
the resolved package from 6.8.9 to 6.8.11. The package's dependency closure
is unchanged. The bootstrap lock document is byte-identical; replacing only
the updater version and integrity in the second document reproduces main's
entire lockfile byte for byte. All unrelated pins and `allowBuilds` policy
are preserved. See `evidence/638-updater/lock-invariants.json`.

No application runtime source changed. Current main's
[Windows recovery contract](../UPDATING.md#windows-failed-update-recovery-contract-660-c5a-02)
remains authoritative: timeout, error event or synchronous throw after
`quitAndInstall` is unknown; admission and drafts stay closed, without
abort, reconnect or duplicate install. Only positive pre-invocation
non-launch evidence can permit recovery. Existing driver, state-machine
and ownership-recovery tests remain in place.

The complete upstream tag comparison ends at
[`e2a8604535bdc626bd068ddf5b6afb67bed45725`](https://github.com/electron-userland/electron-builder/commit/e2a8604535bdc626bd068ddf5b6afb67bed45725).
Review included the actual distributed JavaScript, declarations and maps,
not just release notes. Four distributed JavaScript modules change:
`DownloadedUpdateHelper`, `DataSplitter`, `multipleRangeDownloader` and
`AppUpdater`. Other affected updater classes have declaration/map changes.
The public `downloadUpdate()` still returns `Array<string>` although the
internal executor now returns named file fields.

## Executed real-library fixtures

`tools/test/electron-updater.test.js` resolves the app's actual installed
package and its own dependency closure. It adds 20 bounded cases:

- Missing, null, empty, non-string, absolute, traversal and nested cache
  filenames are refused; cleanup remains inside the owned pending
  directory. A valid basename is reused only after hashing the file;
  altered bytes and changed checksum metadata are refused.
  A separate comparison using the downloaded 6.8.9 payload and the same
  unchanged dependency closure accepts an owned `../outside.exe` sentinel;
  6.8.11 refuses it and preserves that sentinel. See
  `baseline-cache-regression.json` in the evidence folder.
- CRLF and bare-LF multipart bodies are parsed at every two-chunk split,
  including split header terminators, and with one-byte chunks. A real
  differential reconstruction interleaves 502 downloaded ranges and copied
  blocks across 1,004 operations/two HTTP requests. Its second batch takes
  over 10 seconds, proving that the completed first batch's watchdog does
  not reject it. A separate controlled-response fixture proves that an
  ended response with missing parts still aborts at the 10-second grace
  period.
- Real `NsisUpdater.checkForUpdates()` and `downloadUpdate()` use inert
  synthetic bytes from an owned loopback feed. Differential success,
  evicted installer, corrupt old installer and missing-blockmap fallback
  produce the exact expected SHA-512-verified bytes and public result shape.
  Stale pending blockmaps are removed; current maps are refreshed or
  removed when no new map was produced. A second download reuses cache
  without another request.
- A corrupt full download is refused before signature dispatch and leaves
  no installable pending file. A synthetic wrong-publisher verifier result
  is also refused and cleaned up. Neither emits `update-downloaded`.
- A real metadata 401 is followed by an explicit retry using rotated
  synthetic authorization. Metadata, blockmap and Range requests all carry
  the current synthetic header. Checking alone does not download.

Electron's `net.request`/session boundary is substituted with Node HTTP,
restricted to the fixture's loopback host. The library's download, digest,
progress, parser, differential planner, fallback and cache implementations
are real. The incomplete-response case uses a controlled transport and fake
timers around the real parser/watchdog. Native Authenticode verification is
an explicit stub: the publisher-dispatch/refusal test is not proof of a
valid Windows signature or publisher identity. Install/quit entrypoints are
guarded and never invoked; implicit installation is disabled.

The initial direct-parser harness incorrectly awaited additional writes
after the library had signaled completion, producing two harness timeouts.
It now hands off at that completion boundary. The unchanged library can
emit `Trailing ignored data` for a separately chunked MIME epilogue; the
real download fixture still completes with exact reconstructed bytes. This
does not establish general malformed-MIME robustness. Windows-native path
separator behavior, Electron TLS/proxy/session behavior and an installed
Windows N-to-N+1 cycle were not exercised on Linux.

`packages/app/test/update-driver.test.ts` separately retains the mocked
ORCA driver tests for HTTPS/URL restrictions, token-file rotation and
post-invocation unknown outcomes. Two added cases verify exact progress
listener removal after both successful and rejected downloads. These tests
are driver lifecycle evidence, not real-library download proof.

## Integrity, registry trust and retained residuals

Fresh baseline and candidate full audits are identical and report zero
advisories (549 total dependencies). Both production-only audits report
zero (162 total). No audit fix, ignore or override was used. Raw responses,
install logs and checksums are retained in `evidence/638-updater/`.

`pnpm audit signatures` verified all 549 registry signatures. Both updater
tarballs were independently downloaded from npm's registry, SHA-512 and
SHA-1 rehashed, and their registry signatures cryptographically verified
with registry keys. Candidate integrity matches the lock. Every distributed
candidate file matches its installed counterpart; only pnpm's added
dependency links are extra. Neither package declares lifecycle scripts.

The decoded candidate SLSA statement binds the matching tarball SHA-512 to
upstream commit `e2a8604535bdc626bd068ddf5b6afb67bed45725` and
`electron-userland/electron-builder/.github/workflows/pr-release.yml` on
`refs/heads/release/v26`. This digest/statement comparison is not independent
cryptographic SLSA verification. The prior trusted-root-refresh HTTP 403
documented in [the Happy DOM review](2026-10-25-happy-dom-21.md#payload-and-provenance-evidence)
remains a limit; that denied endpoint was not retried, mirrored or bypassed.

This patch is not #521 remediation. Magicast 0.5.5's embedded
`source-map-js@1.2.1` remains, while its external 1.2.2 resolution is
unchanged. The prior actual-payload finding and scope assessment in
[#521 comment 6405046994](https://github.com/cschadewitz/Project_Orca/issues/521#issuecomment-6405046994)
and the Happy DOM report remain applicable; Magicast was not rehashed this
pass. A clean registry audit does not remove embedded code. Packaging's
legacy `@electron/get@3.1.0` closure also remains unchanged for later #639
inspection.

## Validation

All checks below passed against the final dependency/test content. Subsequent
changes only recorded prose and evidence; the raw responses are retained with
checksums in `evidence/638-updater/evidence-manifest.json`.

| Check | Result |
| --- | --- |
| Baseline and candidate `pnpm install --frozen-lockfile`; candidate repeat with `--no-trust-lockfile` | Passed under the existing lifecycle policy, Electron binary download skipped. Initial installs checked 534 lock entries. |
| `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check` | Passed. |
| `pnpm run build` | Passed; existing renderer chunk-size warning remains. |
| `VITEST_MAX_WORKERS=2 ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm run test:coverage` | 512 files passed, 5 skipped; 7,991 tests passed, 36 skipped, 1 todo; no failures. All unchanged global/app/renderer thresholds passed. |
| Full coverage | Statements 91.26%, branches 85.34%, functions 93.26%, lines 93.82%. |
| Real updater / mocked driver / updater state machine | 20 / 8 / 16 tests passed respectively, without skips. |
| `ORCA_RETRY_INTEGRATION=1 VITEST_MAX_WORKERS=2 pnpm exec vitest run packages/cli/test/admission-retry-wiring.test.ts packages/integrations/test/admission-retry-acp.test.ts` | Both required cases passed separately with no skips. |
| `node packages/cli/dist/main.js demo` | Passed against the compiled graph; its disposable scripted workspace was removed. |
| Full/production audits and registry signatures | Zero advisories before/after; all 549 registry signatures verified. |
| `git diff --check`, lock/payload/evidence invariants | Passed. |

The full suite's existing skips/todo are enumerated in
`validation-summary.json`; the two retry cases that are skipped by default
were explicitly executed afterward. Native/platform cases were not turned
into passing acceptance claims. Initial harness timeouts are described above;
the corrected fixtures passed both their focused run and the full coverage
suite. Native Windows install/signature acceptance, Electron App smoke,
packaged artifacts and independent SLSA verification remain outside this
executed evidence. Required GitHub CI is a separate exact-commit result to
inspect after publishing the draft successor.
