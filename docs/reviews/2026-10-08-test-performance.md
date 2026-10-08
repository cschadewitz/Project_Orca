# Test-performance evidence, 8 October 2026

## Provenance

One implementation agent; author self-review, no independent reviewer. Benchmark
base: `10834758e49a5e84b9ac06e3bca85f87be923dac`. The after measurement used that
same source plus the performance patch, before incorporating concurrent main
`93aa9d1352bb25a24e9fb84940674c3e5dcd78f9`. Publication compatibility checks are
separate from the controlled pair below.

Saved Linux cloud container: x86_64, kernel 6.18.44, AMD EPYC 9V45, Node 24.19.0,
Vitest 5.0.2. Five visible CPUs, four-CPU cgroup quota, 16 GiB memory limit.
Both runs explicitly used **one worker**, no coverage, and production-required MCP
mounts. No worker limit, sharding, timeout increase or CI rerun was introduced.
The supplied CI542 Node 22 / two-CPU figures motivated the work; these cloud
measurements are not a controlled comparison against that different runner.

The ambient pnpm 11.19.0 attempted setup in an unwritable home directory. Existing
installed binaries were used directly; no dependency or lockfile change was made.
`node_modules/.bin/tsc -b tsconfig.build.json` freshly compiled production children
before the baseline and again after incorporating main.

## One before/after pair

Run from the repository root:

```bash
VITEST_MAX_WORKERS=1 ORCA_MCP_REQUIRE_PRODUCTION=1 node_modules/.bin/vitest run \
  packages/app/test/mac-update-restart.test.ts \
  packages/cli/test/demo.test.ts \
  packages/engine/test/artifact-watcher.test.ts \
  packages/integrations/test/mcp-operator-production-authority.test.ts \
  packages/integrations/test/mcp-operator-production-lifecycle.test.ts \
  packages/integrations/test/mcp-operator-production-recovery.test.ts \
  --reporter=default --reporter=json --outputFile.json=/tmp/orca-perf-before.json \
  > /tmp/orca-perf-before.log 2>&1
```

The after command:

```bash
VITEST_MAX_WORKERS=1 ORCA_MCP_REQUIRE_PRODUCTION=1 node_modules/.bin/vitest run \
  packages/app/test/mac-update-restart.test.ts \
  packages/app/test/compiled-source-fixture.test.ts \
  packages/cli/test/demo.test.ts \
  packages/cli/test/demo-workspace.test.ts \
  packages/engine/test/artifact-watcher.test.ts \
  packages/integrations/test/mcp-operator-production-authority.test.ts \
  packages/integrations/test/mcp-operator-production-lifecycle.test.ts \
  packages/integrations/test/mcp-operator-production-recovery.test.ts \
  --reporter=default --reporter=json --outputFile.json=/tmp/orca-perf-after.json \
  > /tmp/orca-perf-after.log 2>&1
```
Console logs are `/tmp/orca-perf-before.log` and `/tmp/orca-perf-after.log` in the
selected environment. File timings below come from the console reporter, including
hooks; JSON test start/end spans alone omit the demo's expensive `beforeAll`.

| File/family | Before tests | After tests | Before | After |
| --- | ---: | ---: | ---: | ---: |
| Mac restart | 61 | 61 | 32.803 s | 25.475 s |
| CLI demo, including new workspace contracts | 4 | 5 | 25.759 s | 9.251 s |
| Artifact watcher | 4 | 5 | 23.015 s | 0.006 s |
| New compiled-cache regressions | 0 | 3 | — | 0.050 s |
| MCP authority, unchanged | 24 | 24 | 37.967 s | 41.207 s |
| MCP lifecycle, unchanged | 24 | 24 | 29.209 s | 29.343 s |
| MCP recovery, unchanged during measurement | 12 | 12 | 37.846 s, one failure | 19.237 s |

The changed families, including new regressions, total **81.577 → 34.782 seconds**
(46.795 seconds / 57.4% less file execution time). Whole invocation:
**188.82 → 127.08 seconds**, but that total is not a clean performance claim:
the baseline had a recovery failure. Baseline: six files, 128 passed / one failed;
after: eight files, 134 passed, zero failed/skipped. These are single observations,
not a statistical performance estimate. Vitest may reorder files between runs.

MCP authority/lifecycle show no measurable benefit and remain hotspots. Recovery's
apparent improvement includes disappearance of the baseline failure, not an
optimization, and must not be claimed as savings.

## Preserved assertions and boundaries

- All 61 Mac restart cases and their 115 static `expect` sites are unchanged.
  Every fixture still owns a fresh root, workspace, manifests, images, credentials,
  child processes and cleanup. Only an immutable source string/digest and private
  input digest snapshot are cached within a worker. Entry/root/build options/runtime
  are fixed for that cache; changed control/dependency bytes invalidate it. Every
  child launch retains source-content and selected-binary checks. Old fixtures keep
  their original source snapshot and fail on mid-fixture changes.
- Three cache regressions prove reuse, independent mutable images, transitive
  content invalidation even with restored mtime/unchanged size, control invalidation,
  missing-input refusal and recompilation after repair. No timestamp-only shortcut.
- The two CLI cleanup/keep cases move with their original expectations into real
  command/filesystem tests with controlled bootstrap/workflow output. The full
  scripted ACP demo and README workflow using the generated config remain real.
  An additional thrown-workflow case proves detachment and deletion. Across the
  moved helper/cases, static `expect` sites increase from 18 to 21.
- All four watcher cases keep their original expectations and advance the same
  23 seconds of modeled time asynchronously. Exact call count and cancellation
  during an in-flight check add proof; static `expect` sites increase 11 → 16.
  Fake timers are cleared/restored after every test.
- MCP authority, lifecycle and recovery were inspected rather than indiscriminately
  replaced: real credential administration/revocation, HTTP/WS/stdio, private
  projections, live callbacks, restart and cross-process replay remain acceptance.
  Dynamic assertion totals vary with readiness polling; the static counts above
  are not represented as runtime assertion totals.

## Baseline recovery blocker

R04 over stdio failed at the first post-restart `continue_run` with
`AGENT_TRANSPORT`; the broad after-run passed both transports. On a requested
focused investigation, the second R04-only invocation reproduced the failure.
Failure-time filesystem inspection found an empty `state/runs/<run>.jsonl.lock`
directory. Progress diagnostics showed the replay rejecting at 15,007 ms.
`withFileLock` intentionally retains empty/unknown-owner directories; random
SIGKILL can hit the directory/owner publication or removal gap. This is not fixed
by raising transport timeouts or automatically deleting unknown locks.

## Validation and self-review

- Fresh production TypeScript build and root `tsc -p tsconfig.json --noEmit` passed.
- Renderer `tsc -p packages/app/renderer/tsconfig.json --noEmit` passed on the benchmark
  base; no renderer files are changed here.
- Focused ESLint and Prettier checks passed for all seven changed TypeScript files;
  `git diff --check` passed.
- No application behavior, credentials, security policy, CI configuration or
  production storage protocol changes are part of the performance patch.
- No full-suite/coverage, Electron/native-mac, deployment or live-provider proof is
  claimed. No intermediate push or independent review agent was used.

## New-main compatibility

After one rebase onto `93aa9d1`, the performance implementation commit is
`ae725da7f422184cb6cd21ad6e75182fc182e476`. Both fresh production compilation and
root typechecking passed. This distinct compatibility invocation passed **74/74
in five files, 41.11 seconds**, with no skips:

```bash
VITEST_MAX_WORKERS=1 ORCA_MCP_REQUIRE_PRODUCTION=1 node_modules/.bin/vitest run \
  packages/app/test/mac-update-restart.test.ts \
  packages/app/test/compiled-source-fixture.test.ts \
  packages/cli/test/demo.test.ts \
  packages/cli/test/demo-workspace.test.ts \
  packages/engine/test/artifact-watcher.test.ts \
  --reporter=default --reporter=json --outputFile.json=/tmp/orca-perf-integrated.json \
  > /tmp/orca-perf-integrated.log 2>&1
```

## Approved R04 test repair

After the original reproduction, the user requested a fix and explicitly approved
this bounded test-only crash barrier in the parent conversation. No second
investigator/reviewer was used. The empty-lock production boundary remains
**unsupported and unresolved**; moving the crash point is not a production repair.

R04 opts its daemon into a test preload that forwards actual filesystem writes
unchanged, then holds completion of the selected journal's real owner-file write.
It is armed only after the real committed acknowledgement has been dropped and
captured. An authenticated continuation inspection ensures another journal lock
acquisition occurs. No wait for workflow settlement, synthetic receipt, replacement
handler or fake store is introduced.

New causal assertions, on both stdio and HTTP, prove:

1. The selected published owner has the actual daemon PID and host.
2. Its owner file exists before **real SIGKILL** and still exists afterwards.
3. The outstanding actual RPC is interrupted by process death.
4. The replacement has a new instance identity and the same workspace identity.
5. Production recovery removes that exact dead-owner file, and the original
   receipt replays with the same operation/continuation/run correlation.

All original lost-ACK count, exact replay, inspection, reconciliation, changed-payload
conflict, single decision-event and private-rationale audit assertions remain.
The existing JSONL test still refuses an empty lock with `STORE_LOCK_TIMEOUT`;
that negative proof and competing-owner recovery tests were run alongside R04.
The barrier selects a supported crash boundary. It does not certify arbitrary
crash-point recovery, repair unknown ownership, or prove production empty-lock
recovery.

Focused R04 check after the barrier: two selected cases passed, 5.37 seconds;
ten other cases were excluded by `-t R04`, not newly skipped in source. The full
post-repair command below passed **23/23 tests in three files, 21.34 seconds**, with
no skips. These are repair/compatibility checks on the newer main, not part of the
original performance comparison:

```bash
VITEST_MAX_WORKERS=1 ORCA_MCP_REQUIRE_PRODUCTION=1 node_modules/.bin/vitest run \
  packages/integrations/test/mcp-operator-production-recovery.test.ts \
  packages/store/test/jsonl-log.test.ts \
  packages/store/test/file-lock-recovery.test.ts \
  --reporter=default --reporter=json --outputFile.json=/tmp/orca-perf-final-recovery.json \
  > /tmp/orca-perf-final-recovery.log 2>&1
```

Root typechecking and focused ESLint also passed after the barrier implementation.
The final review checked the opt-in preload, unchanged default boot arguments,
source-cache isolation/invalidation, preservation of original assertion bodies,
absence of production/CI edits, and cleanup ownership. No MCP performance saving
is claimed for this repair; its extra setup boot is intentional test overhead.
