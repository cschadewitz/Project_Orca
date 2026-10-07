# Production MCP credential-admin import experiment (#510)

Scope: the production test fixture's credential-admin subprocess imports emitted
`packages/daemon/dist/auth/bootstrap.js` instead of emitted `dist/index.js`.
Every issue/revoke still launches its own Node process and calls the same
`openAuthDirectory`. No runtime, workflow, selector, timeout or existing assertion
is changed. Implementation was explicitly authorized after the investigation in
[#510](https://github.com/cschadewitz/Project_Orca/issues/510#issuecomment-6032859261).

## Experiment contract (written before measurements)

- Base: verified remote main `d3491cc06b5abc1c5d82f2c685d6f628d9d4b04b`, tree
  `db6e22b47cafb1504ebdab1c3ef9cac0b06cad90`. Recheck before publication.
- Separate base/candidate checkouts, frozen-lockfile dependency preparation with
  pnpm 12.4.2, official Node 24.21.0 verified against official SHASUMS256.txt.
  Delete old emitted output and rebuild each exact checkout. Retain hashes of
  emitted artifacts, fixture, three existing consumer tests, and lockfile.
- One task command/test workload at a time, one Vitest worker, no file parallelism.
  Synthetic workspaces use a task-local `/workspace` scratch directory on overlay
  storage; `/tmp` is tmpfs. Neither is physical-media or cold-storage evidence.
- Measure six alternating-order pairs of fresh-process issue/revoke sequences
  with identical options and independent auth directories. Separately verify the
  two emitted exports have identical function identity. Persist timings, exit
  outcomes and process counts, never credential/token contents.
- Measure three alternating-order pairs of all three existing production MCP
  consumer files. Record supervisor wall time, each file duration, every stable
  test name/status, and zero unexpected skips. Each invocation has a 600-second
  wall limit plus a five-second termination grace. Existing test/hook deadlines
  remain unchanged. Stop on failure and retain it; no benchmark retries.
- Add a focused regression for emitted export identity, fresh completed admin
  processes and revocation observed by the running compiled daemon. This added
  test is outside the fixed 60-case timing workload.
- Run final-candidate typecheck, lint, formatting, design freshness, explicit
  CLI/ACP no-skip acceptance, full ordinary/coverage gates and emitted demo as
  capacity permits. Record unrun/failed/blocked gates explicitly. Local cloud
  measurements cannot establish homelab queue, contention or CI speedups.

## Assertion-preservation matrix

All rows run via both existing `stdio` and `http` MCP transports. The three
consumer files remain byte-for-byte identical to base. Their original fixtures,
negative inputs, fault injection, timing barriers and expectations remain intact.

| Stable IDs | Preserved scenario/oracle | Change impact |
| --- | --- | --- |
| A01, A07 | Current revocation before all ten aliases and late-publication revocation barrier | Fresh admin process uses identical credential store; dispatch/publication unchanged |
| A02, A03, A09 | Grants, workflow/owner scope, deployment/input/caller identity, cross-run artifacts, strict backing HTTP/WS schemas | Same isolated identities and refusals |
| A04, A05 | All live identity fields, original callback, owner death and restart expiry | Same compiled processes, callbacks and restart |
| A06, A08 | Bounded pages, cursor invalidation, exact audit correlations, no secret disclosure | Same ownership/audit stores and disclosure assertions |
| A10, A12 | Missing protected evidence, whole-read failure, safe cold-read uncertainty without hidden retries | Same fault injection, authoritative reads and refusal behavior |
| A11 | All ten aliases over backing HTTP and WS, real receipts/effects | Same production handlers/transports |
| F01–F04 | Authenticated discovery, capability/HTTP/WS parity, preflight, disk admission, gate/live/parent workloads, continuation and scripted execution | Same fresh workspace and emitted daemon/CLI/MCP/ACP processes |
| L01–L05 | Request/direct identities, exact answer without resume, answer+continuation, pinned protected revision exactly once, descendant cancellation | Same durable stores, workloads and expected receipts |
| R01–R05 | Lost acknowledgements, durable replay, daemon death, old-target refusal, separate concurrent writers, answer/continuation/revision recovery | Same process launches, restart/SIGKILL boundaries and replay/fault scenarios |
| Fixture contract | Fresh state per test, sanitized child environment, cleanup, production-required failure, existing polling/read deadlines | Only admin import URL changes |
| Added regression | Direct and barrel emitted export identity; distinct completed issue/revoke PIDs; real daemon rejects revoked token | Additional proof, excluded from comparative timings |

The existing persistence baseline in
[../persistence-baseline/](../persistence-baseline/README.md) supplies the paired-order
and provenance method. No store workload harness is duplicated. Its pinned
`e94bf699` results are historical; physical-media/power-loss, true storage-cold and
private-phase evidence remain open under #408. This fixture change makes no
runtime persistence improvement or durability acceptance claim.

## Results

Measurements completed on 2026-10-07. The final fixture differs from base by one
import URL. No original consumer test changed. The added regression proves the
emitted export identity, three distinct completed admin processes and a real
daemon's HTTP 401 / `AUTH_INVALID` refusal after revocation.

| Measurement | Before median (range), seconds | After median (range), seconds | Samples per side |
| --- | --- | --- | --- |
| Fresh issue + revoke subprocesses | 0.832 (0.780–0.837) | 0.504 (0.479–0.579) | 6 |
| Combined production consumers, supervisor wall | 239.484 (237.261–244.200) | 229.571 (215.573–239.558) | 3 |
| Authority file, within the combined run | 106.290 (103.396–116.765) | 96.922 (91.953–98.165) | 3 |
| Lifecycle file, within the combined run | 80.595 (79.805–84.511) | 80.173 (74.399–83.148) | 3 |
| Recovery file, within the combined run | 49.025 (44.729–49.620) | 47.517 (47.171–59.039) | 3 |

The credential-operation median is **39.4% lower**. The combined-suite median is
**4.1% lower locally**, with paired savings of **9.912, 4.642 and 21.688 seconds**.
All six suite invocations passed the identical 60 named scenarios: **360 passed,
zero failed/skipped/todo**. The six final micro pairs each completed two fresh
processes per variant and verified persisted revocation; the emitted identity
checks also passed. File timings are components of the combined serial workload,
not independent isolated-file experiments, and must not be added to supervisor time.

Sample variance is material: the candidate suite spans almost 24 seconds, and the
second candidate recovery file took 59.039 seconds versus its paired baseline's
44.729 seconds. Lifecycle medians are almost equal. Three suite pairs cannot give
a reliable p95, confidence interval, CI budget or whole-CI speedup. The measured
startup reduction supports this narrow change; private runtime phase attribution,
host interference and repeatability on homelab remain unknown. No broader fixture
or runtime optimization is included.

An earlier, pre-edit probe compared both import paths in the same rebuilt baseline
checkout: six pairs, 0.959 / 0.583-second medians. It is retained separately as
`micro-prechange`; it is not pooled with the independently rebuilt-checkout results.
The old 30.465-second recovery smoke in the issue comment used Node 24.19.0 and
uncertified saved artifacts, so it is not a comparable baseline here.

## Provenance and bounds

The suite measured base `d3491cc06b5abc1c5d82f2c685d6f628d9d4b04b` against
implementation `bca6c6986f406fc8fa62eabe4e8ecaf9b515db57` (tree
`8df6b1e2ad4156f1ca3b1f35e29c9f0cb87046ea`). The final micro experiment used
`c8cd3677cb7acff7daaf8b33eee95cbd7287ebb0`; its subsequent change only corrected
the added regression, outside the measured fixed workload. The fixture and all
compiled runtime bytes remained identical. Later publication adds evidence/docs.

Both checkouts received frozen installs and `pnpm run clean` followed by
`pnpm run build`. Of **1,086 recorded hashes** (1,081 emitted files plus the fixture,
lockfile and three consumers), only the fixture hash differs between controls.
Subsequent fresh Node 22 and 24 builds match the candidate hash set exactly.
Full hashes, exact heads/trees, Node binary hashes, commands, timings and statuses
are in the [evidence packet](evidence/README.md).

Linux 6.18.44, x86_64, glibc 2.41; five affinity-visible CPUs, cgroup quota of four
CPUs and 16 GiB memory. These are allocation observations, not physical-host
capacity. Synthetic workspaces used `/workspace` overlay storage; `/tmp` is tmpfs.
Small supervisor buffers in the paired experiment used the default temp location;
aggregate buffers/workspaces used the disk-backed task scratch path. Storage caches
were warm/recently populated by builds and hashing. No cache flush, physical-media
or power-loss claim is made. Suite load averages were recorded before/after; no
CPU-steal, private I/O, peak-process or homelab contention attribution was collected.

All task workloads were serialized. Each suite sample had a 600-second supervisor
bound, each micro child 10 seconds, with five-second termination grace. One worker,
no file parallelism, original test/hook timeouts and normal durability remained.
The supervisor's micro timings include spawn, import, stdin protocol, credential
I/O and exit; they do not isolate pure import time. Tokens and credential records
were discarded, and synthetic auth directories were cleaned after each sample.

The initial login PATH still exposed Node 24.19.0 / pnpm 11.19.0. Official Node
24.21.0 and 22.23.3 archives were checked against official SHA-256 manifests before
execution; pnpm 12.4.2 was selected from the existing task-local installation.
Every command activates the correct PATH **after shell startup**. `pnpm exec node`
also verified the selected child executable. No platform profile or environment
template was edited; a setup export cannot override later login-shell PATH resets.

## Final validation and retained failures

- Whole-repository typecheck, lint, format, design freshness and diff checks: passed.
- Clean builds on Node 22.23.3 and 24.21.0 with pnpm 12.4.2: passed; all measured
  hashes match. The renderer's existing large-chunk advisory remains.
- Explicit `ORCA_RETRY_INTEGRATION=1` CLI/ACP acceptance: both named files, **2/2
  cases passed with zero skips on each Node**. Both emitted CLI demos passed.
- Node 22 full ordinary: **4,726 passed, 1 failed, 3 existing opt-in skips**, 340
  files / 4,730 discovered cases, exit 1, **1,024.221 seconds**.
- Node 24 full coverage attempt: the same **4,726 passed, 1 failed, 3 opt-in skips**,
  exit 1, **1,121.885 seconds**. All **61** cases (60 original production scenarios
  plus the added fixture regression) passed on both Nodes, including both MCP transports.
- The three full-suite skips are the CLI/ACP opt-ins exercised separately and the
  live TypeSafe API evaluation, which remained unrun without provider access.
- The sole aggregate failure is unchanged
  `packages/store/test/protected-execution-store.test.ts:216`, "keeps legacy workflow
  snapshots readable and encrypts only newly recorded snapshots". It requests
  `mkdir(..., {mode: 0755})` then assumes 0755. The task's existing umask **0077**
  creates **0700**, which the runtime preserves. The exact case also fails on
  untouched baseline (exit 1, one failed / twelve intentionally filtered cases).
  Source hashes are identical. No umask, store test, permission or runtime policy
  was changed to conceal this result. Local full-suite green remains blocked.
- Failed tests prevented Vitest's final coverage summary/report and threshold
  verdict. Its JSON includes the collected 400-file coverage map, retained in the
  packet. **No coverage-threshold pass is claimed.** No broad retry was performed.
- Two added-regression authoring failures are retained under `development/`: first
  an invalid hello payload, then using the authorized-RPC ID helper for an auth
  refusal whose ID is zero. The corrected regression passed, including both full
  Node lanes. These were not failures of the fixed comparative production workload.

Node 22 paired performance, coverage before/after overhead, whole-CI savings,
homelab replication, native/Electron/platform acceptance and a statistical budget
remain unmeasured. Broader #510 and #408 acceptance remain open. Roll back by
reverting the one fixture import URL; keep the existing production contracts intact.

## Reproduce without changing the environment template

Use separate checkouts of the recorded base and candidate, with a frozen install
and clean build in each. Set `NODE_BIN` to the verified Node 24.21.0 binary directory
and `PNPM_BIN` to the verified pnpm 12.4.2 directory. Activate them inside each
shell invocation; use a non-login child shell or repeat activation after login.

```sh
export PATH="$NODE_BIN:$PNPM_BIN:$PATH"
node --version
pnpm --version
pnpm exec node -p 'process.version + " " + process.execPath'
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm run clean
pnpm run build

python3 docs/performance/mcp-credential-admin/measure.py micro \
  --baseline "$BASE" --candidate "$CANDIDATE" --scratch "$SCRATCH" --output "$OUT/micro"
python3 docs/performance/mcp-credential-admin/measure.py suite \
  --baseline "$BASE" --candidate "$CANDIDATE" --scratch "$SCRATCH" --output "$OUT/suite"
```

`SCRATCH` is a disposable directory outside any Git checkout on the selected backing
filesystem. Output directories must not exist. Verify the recorded artifact and
consumer hashes differ only at the fixture import before interpreting results.
The final fixed-workload and aggregate commands are recorded verbatim in the
packet; the latter used 1,800/2,400-second Node 22/24 bounds respectively, with
the same one-worker/no-file-parallelism and production-required flags.
