# Electron 44 maintenance assessment

Assessed 30 October 2026 on Linux x64, based on main
`5bc414941275545d136e47409e42cf738a98c97b`. Recommend the compatible maintenance
update **44.9.1 → 44.10.0** for review, subject to the existing candidate gates.
This is a semver minor within 44, not a strict patch-only 44.9.z update. It already
satisfies the old `^44.9.1` range; the new requirement `^44.10.0` raises its floor.
The lockfile selects exactly 44.10.0. No release version or candidate is selected.

Repository `AGENTS.md`, development/architecture/release guidance and workflow
triggers were inspected. Neither the repository nor `/workspace/.agents` contained
applicable `.agents/skills` instructions. This is separate from deferred
[#796](https://github.com/cschadewitz/Project_Orca/pull/796), whose inspected head
`0121a8329dfd907d08cbd4caf4b06749979ec0b9` upgrades to 45.0.0. Its disposition
[holds the major update](https://github.com/cschadewitz/Project_Orca/pull/796#issuecomment-6530540249).
This work does not accept that PR or its major-version behavior changes.

## Published target and official evidence

The [Electron index](https://releases.electronjs.org/) and npm registry both
identified **44.10.0** as the newest published stable 44 release during this
assessment. The index still listed **44.10.1 as Building**, so it was excluded.
45.2.0 appeared as released during the assessment; it is outside this update.
Recheck publication before final candidate selection. Electron supports the
[latest three stable majors and latest minor in each](https://www.electronjs.org/docs/latest/tutorial/electron-timelines#version-support-policy),
which includes 44 at this observation.

| Component | Existing 44.9.1 | Selected 44.10.0 |
| --- | --- | --- |
| Chromium | 152.0.7977.167 | 152.0.7977.169 |
| Node | 24.22.0 | 24.22.1 |
| V8 upstream version | 15.2.124.43 | 15.2.124.45 |

Sources: [44.9.1](https://releases.electronjs.org/release/v44.9.1),
[44.10.0](https://releases.electronjs.org/release/v44.10.0) and its
[GitHub release](https://github.com/electron/electron/releases/tag/v44.10.0).
The downloaded runtime independently reported Electron 44.10.0, Node 24.22.1,
Chromium 152.0.7977.169, V8 `15.2.124.45-electron.0`, module ABI 149 and N-API 10.

The intermediate [44.9.2 release](https://github.com/electron/electron/releases/tag/v44.9.2)
has no substantive published notes; do not invent a fix list for it.
[44.9.3](https://releases.electronjs.org/release/v44.9.3) records upstream ANGLE,
Chromium, PDFium, Skia and V8 backports. The 44.10.0 notes include File System
Access blocklist corrections, malformed ASAR and main/child ASAR-path handling,
protocol fetch-rule corrections, Linux D-Bus and X11 paste fixes, and updates
to Chromium and Node. Those notes do not supply a complete CVE-to-backport map;
this assessment does not claim one.

## Security delta and ORCA exposure

- [Node 24.22.1](https://nodejs.org/en/blog/release/v24.22.1) is a security release.
  Its high-severity fixes cover TLS non-canonical IP handling
  (CVE-2026-106069/106072), DNS null-byte validation (CVE-2026-105482), TLS IP
  normalization (CVE-2026-105483), and Brotli (CVE-2026-111497). It also fixes HTTP
  agent guarding, snapshot random caches and permission-model realpath checks.
  These are upstream affected-runtime findings, not demonstrated ORCA exploits.
- The high-severity [eMudhra advisory GHSA-jr5w-w6x2-84p9](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)
  was already fixed in **44.9.1**. Likewise the October pointer-lock,
  [openExternal](https://github.com/electron/electron/security/advisories/GHSA-997q-gvvc-jwmx)
  and [HID/USB](https://github.com/electron/electron/security/advisories/GHSA-fw47-9c62-h3vw)
  origin-attribution advisories were fixed before the baseline (44.5.0 and
  44.3.0 respectively; [pointer-lock advisory](https://github.com/electron/electron/security/advisories/GHSA-x562-297c-g43g)).
  They are not newly repaired vulnerabilities in this branch.
- ORCA's packaged daemon uses the Electron executable with
  `ELECTRON_RUN_AS_NODE=1` (`packages/app/src/main/daemon-process.ts`), so the
  embedded Node update matters to daemon behavior as well as the desktop main
  process. Separately installed daemon/CLI runtimes remain the operator's Node;
  this dependency update does not patch those runtimes. Remote daemon TLS and
  private HTTPS update transport make network-runtime fixes relevant, conditional
  on the configured endpoint and attacker access. Local authenticated loopback
  probes do not test hostile TLS, DNS or compressed responses.
- The production renderer loads bundled files, with `contextIsolation: true`,
  `sandbox: true`, CommonJS preload and the existing restrictive CSP. Source
  searches found no use of session preload registration, `protocol.registerSource`,
  `onSendHeaders`, File System Access picker APIs or `utilityProcess`. Their fixes
  offer defense in depth; no direct ORCA path was established for those APIs.
  Local rendering still uses Chromium/V8, and packages use ASAR, so packaged launch,
  preload/bridge integrity, child launch and archive-path regression checks matter.
- Windows/macOS diagnostic and first-run native modules have their own packaging
  and real-runtime gates. Linux source/unit fixtures cannot accept those modules.
  Linux clipboard and renderer/type rendering deserve checks on the selected build.
  None of the above requires relaxing authentication, sandbox, CSP or signing rules.

## Duplicate inventory and patch scope

GitHub searches covered Electron-titled PRs across all states, current Dependabot
PRs, the #796 discussion and Electron-named branches. No matching maintained-44
PR or branch was found. The only Electron version branch returned was #796's
`dependabot/npm_and_yarn/electron-45.0.0`. Weekly Dependabot configuration groups
minor/patch development updates; open grouped
[#795](https://github.com/cschadewitz/Project_Orca/pull/795) contains only MCP
client/core updates. Open #797–#799 concern MCP server, typescript-eslint and ACP.
No PR, comment, label or Dependabot setting was changed.

The executable change is one manifest requirement and the matching Electron
package/snapshot/integrity in `pnpm-lock.yaml`. A structured YAML comparison
verified the pnpm-toolchain document is unchanged, the entire workspace lock graph
is identical after normalizing that Electron version/integrity, and no transitive
package, peer closure or other manifest value changed. Registry integrity:
`sha512-ss4pCfrQKV4TWkuVYtWB4HmeysPZgB96cSYNKYZv1UVCRP4vQMGNW5oopFbvx6Bbfce1XtP5pm5RDuKehp0svQ==`.

## Validation and limits

The [command record](evidence/electron-44-maintenance/commands.txt) and
[structured scope receipt](evidence/electron-44-maintenance/scope.json) accompany the results.
Checks used Node **24.19.0**, repository-pinned pnpm **12.4.2**, Linux x64, and
at most two Vitest workers. Frozen install passed the existing 534-entry supply-chain
policy check. The plain installer initially failed to fetch; enabling Node's
supported environment proxy retained the session proxy and TLS verification.
Its default cache directory was unavailable, so the successful invocation was:

```sh
NODE_USE_ENV_PROXY=1 electron_config_cache=/tmp/orca-electron44-cache \
  node packages/app/node_modules/electron/install.js
```

Normal installer checksum verification remained enabled. No dependency lifecycle
allowlist, security setting or credential changed.

| Check | Result |
| --- | --- |
| `pnpm run typecheck` | Passed, root and renderer |
| `pnpm run lint` | Passed, ESLint and CSS tokens |
| `pnpm run build` | Passed; existing renderer chunk-size warning |
| `pnpm run design:check` | Passed |
| Prettier on changed app manifest; `git diff --check` | Passed |
| Focused daemon/preload/native packaging/updater/release contracts | 13 files, 149 tests passed, zero skips |
| Runtime auth/startup and guided/retry intent fixtures | 4 files, 77 tests passed, zero skips |
| `pnpm --filter @orca/app run build:daemon` | Passed |
| `node tools/probe-bundled-daemon.js` | Authenticated hello passed under standalone Node; ORCA 0.6.0 / protocol 2.0 |
| Actual `startBundledDaemon` with Electron 44.10.0 as `execPath` | Passed; authenticated hello, protocol 2.0, exact owned child/store identity; anonymous RPC returned 401; child stopped and scratch workspace removed |

The [focused test summaries](evidence/electron-44-maintenance/focused-tests.txt)
and [auth summaries](evidence/electron-44-maintenance/auth-tests.txt) record those
runs. The first command also named nonexistent `admission-intents.test.ts`; it ran
13 existing files. The second run explicitly covered the actual intent fixtures.
Native `smoke/admission-intents.spec.ts` was not run. The
[embedded-runtime receipt](evidence/electron-44-maintenance/runtime-probe.txt)
and [exact one-off runner](evidence/electron-44-maintenance/runtime-probe.mjs.txt)
retain the synthetic check without tokens or raw daemon output. The runner's
absolute `/workspace/Project_Orca` paths record this environment.

Calling the standalone probe itself under Electron returned `EARLY_EXIT`: its
`childEnvironment` intentionally drops `ELECTRON_RUN_AS_NODE` while spawning
`process.execPath`. It is a standalone-Node helper, not the product's Electron
child launch. The subsequent check used the real product `startBundledDaemon`
path and passed. Neither check launches a renderer or validates a packaged app.

No display is configured and Xvfb is absent. App smoke, screenshot type proof,
Windows/macOS safeStorage restart, native modules, real install/restart/update,
and packaged artifact validation were not executed. The full suite and coverage
were not run; focused results do not replace required CI or full release checks.
No package, release, workflow dispatch, deployment or release-gate change occurred.

## Bridge smoke follow-up

The reported exact-head App smoke run
[41124495214](https://github.com/cschadewitz/Project_Orca/actions/runs/41124495214)
on `6180c3afb854380bf3d1063527b4d7310dfb4a3b` had 27 Linux passes and one
failure: the exact bridge allowlist omitted `scopedPermissions`. No workflow
list/view or log query was repeated for this investigation; the run result is
provided context, with the mismatch independently reproduced from source.

Commit `3f72ee46fc9f55b3b6f1fe24ad1d757c149a323d` intentionally added the typed
bridge, preload implementation, main dispatcher and closed protocol contracts,
but omitted the smoke allowlist update. Both the original PR head and current
main `2942010e175bebee220f56baf6a6b8ae10c11690` contain that mismatch. It predates
the Electron update. The bridge exposes only `call`; main validates the closed
review/choose/inspect/cancel family, and the daemon retains authentication and
owner authority. Production startup still does not register that family.

The follow-up merges that current main without rewriting either history and
records the intentional key in the exact allowlist. An additional exact nested
assertion permits only `call`. The actual-preload regression checks its IPC
envelope and explicit epoch fencing before and after target activation. No
runtime permissions, registration, authentication or sandbox settings change.

On Node 24.19.0/pnpm 12.4.2, frozen installation, root/renderer typechecks,
TypeScript/Vite build, affected ESLint/Prettier and `git diff --check` passed.
The focused preload/client, renderer choices/port, daemon scoped-bridge and
authorization-inventory suites passed **6 files / 160 tests / zero skips**, with
at most two concurrent workers. Executing the actual preload source independently
confirmed the single missing key before and exact equality after the correction.
Playwright discovers all 28 smoke cases; discovery and source checks are not GUI
smoke. The existing renderer chunk-size build warning remains.

Local GUI smoke remains blocked: Xvfb is absent, and `unshare -Ur true` fails
because `/proc/self/uid_map` is read-only. Obtain fresh full App smoke on the
new exact pushed head in a sandbox-capable runner; the old run cannot accept it.
Any homelab dispatch still requires the owner's fresh resource preflight.
Type proof, native acceptance and the other candidate gates remain separate.

## Required before accepting a private candidate

Preserve every gate in the [private-release ledger](2026-10-27-release-readiness.md),
including R1–R11, the applicable C rows and onboarding G1–G9. A dependency update
alone does not close any of them. Run ordinary CI/full testing on the final head;
obtain selected-build Desktop/bundled-daemon receipts and App smoke/type proof;
inspect exact packaged hashes, ASAR closure, CSP and resources; and obtain the
selected Windows/Linux native install/restart/update/store-restore receipts.
Exercise Windows safeStorage and native modules on the exact candidate where
included. Windows 10 remains upstream-supported but is not accepted for ORCA by
this work. macOS/Apple Silicon acceptance remains separately scoped and deferred.
No workflow was dispatched here; any future homelab job retains the owner's fresh
resource-preflight requirement.

Cal will create the PR. The dependency change can follow the existing
`no-changelog` convention; that is a PR-label choice, not a permission to claim a
new release or to weaken any candidate gate. Recheck duplicate inventory and the
latest published 44.x version if the branch waits before review.
