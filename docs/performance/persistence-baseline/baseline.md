# Main persistence baseline, 2026-10-03

This establishes bounded workloads and a measured baseline for #423. It does not
implement an optimization or complete parent #408's acceptance. The full method,
limits and rerun commands are in [README](README.md); the sanitized raw measurements
and compiled hashes are in the [evidence packet](evidence/README.md).

## Identity and execution

Fetched `origin/main` and used Kepler's sync operation before editing. Main and the
approved issue baseline both resolved to `e94bf699d9f3000de8822ed3434c1dce92b6ce19`, tree
`e2bfc2d786f4458cd3e635f94766698d7faced70`; no later rebase or peer-branch import was needed.
Runtime sources were unchanged. The tmpfs harness hashes match benchmark commit
`40d6fc876a9ff5333d1e6a5f56260edaf519469b`. The isolated ext4 rerun used that checkout
(tree `64d069c287ae01439e9df02cf99f2f1e10c71c32`) plus the uncommitted isolation fix,
whose hashes match the final delivered harness. `40d6fc8` is an unpublished benchmark/docs
commit, **not main**; both suites compile the same approved main runtime bytes. The only
harness behavior difference is the Git discovery boundary, demo working directory,
branch-preservation oracle and command metadata; store fixtures and phase timers are unchanged.

Node **v24.21.0**, Debian **13**, Linux **6.12.107+deb13-cloud-amd64**, x86_64; AMD Ryzen 7
5700U CPU, **8 visible CPUs**, **16,775,966,720 bytes** visible RAM. This is a QEMU VM,
not the machine used in #397. `/tmp` is tmpfs; the worktree mount is ext4 on `/dev/sdb`,
reported as `QEMU HARDDISK`. Physical media and controller guarantees are unavailable.
No host cache flush was attempted. Process-cold and warm results both use recently
copied fixtures and must not be described as cold-storage results.

The session used `/home/casey/.local/bin/mise exec --` to expose the installed Node/pnpm.
Dependencies were installed with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
--frozen-lockfile`. The report commands resolve Node to its exact executable, and both
baseline invocations ran `node node_modules/typescript/lib/tsc.js -b tsconfig.build.json
--force` before collecting artifact hashes. Reproduce the measured commands from the
repository root:

```sh
node tools/benchmarks/persistence-baseline/run.js --profile baseline --scratch /tmp \
  --output docs/performance/persistence-baseline/evidence/tmpfs
node tools/benchmarks/persistence-baseline/run.js --profile baseline --scratch "$PWD" \
  --output docs/performance/persistence-baseline/evidence/ext4-isolated
```

Choose new output names when rerunning; the runner refuses existing directories. Seed
defaults to **423**. Filesystem suites ran sequentially. Six self-checks ran before the
tmpfs suite; all seven, including the added Git-isolation test, ran before the ext4 rerun.
Concurrent host load was not controlled beyond keeping this task's own test
and benchmark processes sequential; the evidence is a local diagnostic, not a CI budget.

## Outcomes and retained failures

- Harness self-checks: **7 passed**, covering the Git discovery boundary, bounds, timeout/output failure accounting,
  dimension independence, rotating order, interval union, summary exclusion of failures,
  and compiled protected-fixture/concurrent-reader oracles.
- Focused ESLint and Prettier checks cover the new harness/docs. Full application,
  coverage, Electron and packaged-hardware suites are **unrun** for this profiling-only
  change. No shared threshold or timeout was changed.
- Initial sandbox attempt: **failed** at `spawnSync git EPERM`, before build or workload.
  A sandboxed dependency install also encountered blocked network access; installing the
  same frozen lockfile with the approved network capability succeeded.
- First supervised build: **blocked** after the compiler crossed the initial 512 MiB
  process-group RSS limit (688,910,336 bytes sampled). The final harness separates a
  2 GiB compiler ceiling from the unchanged 512 MiB workload ceiling. No workload ran
  in that attempt.
- Development smoke: **78 read/append samples passed**; its scripted demo was **failed**
  by the resource monitor. The monitor originally treated a disappearing temporary
  directory as an error. It now tolerates ENOENT during scans and reports other monitor
  failures by code. The old generic monitor result cannot distinguish that race from
  every possible resource-monitor failure. This attempt is retained, not counted as a
  final smoke pass. The final smoke profile is **unrun** after that fix; the larger final
  baseline exercises the corrected supervisor and scripted-demo path.
- The first ext4 run passed its workflow and store oracles but **failed isolation** on
  final review: its disposable directory was inside the checkout, so the local workspace
  provider discovered the parent Git repository and switched among three synthetic
  branches. HEAD and runtime files stayed unchanged. The task branch was restored, the
  benchmark commit preserved, and the three newly created demo branches removed. That
  ext4 packet is retained under `development/` and excluded from final scaling. The fix
  adds a tested Git discovery ceiling, runs each demo in its own directory and checks
  source-branch preservation. The ext4 baseline was rerun after the fix. The earlier
  tmpfs suite had no parent Git checkout and remains valid under its recorded harness
  revision. This corrects the harness, not the runtime's documented local-provider behavior.

The detailed final outcomes and scaling data follow below. No synthetic state, generated
execution keys or raw demo diagnostics are retained.

## Final measured results

The retained tmpfs and isolated ext4 suites **passed**: **26 fixtures, 156 read/append
samples and six compiled scripted demos** in total. Each case/cache/filesystem has three
successful observations. Both forced builds passed and produced the same compiled artifact
manifest: `576a75823d404e992d4534327645804498bb32259482b48984e6badaf1ba774d`
(SHA-256 of raw `artifacts.json`). The isolated ext4 run also verified branch preservation.
All generated scratch state was removed. Fixture allocation before cleanup was tmpfs: 18,472,960 bytes / 4,168 files, ext4: 18,472,960 bytes / 4,168 files.
Total suite times were tmpfs: 258.65 s, ext4: 268.98 s.

Whole measured read-plus-append workload **median [min–max] in milliseconds**. Process-cold
and warm remain separate; process startup, warmup, fixture copy and final oracle are
excluded. Full precision, spread and individual samples are in the packet.

| Case | tmpfs process-cold | tmpfs warm | ext4 process-cold | ext4 warm |
| --- | --- | --- | --- | --- |
| history-32 | 104.86 [99.91–111.24] | 59.96 [53.23–66.13] | 113.11 [112.23–120.20] | 77.73 [73.53–79.78] |
| history-128 | 190.39 [189.18–198.26] | 85.72 [83.87–91.19] | 177.85 [173.91–195.92] | 92.44 [89.39–117.21] |
| history-512 | 396.72 [385.47–397.92] | 205.60 [202.36–209.97] | 391.56 [343.27–429.36] | 284.29 [192.83–367.20] |
| runs-1 | 120.50 [112.51–156.54] | 72.96 [67.56–85.25] | 118.88 [114.40–145.92] | 84.84 [75.68–140.44] |
| runs-8 | 411.62 [332.40–414.30] | 247.99 [228.50–263.14] | 372.42 [327.22–390.00] | 264.68 [257.94–268.48] |
| runs-32 | 1290.34 [1199.12–1313.97] | 1155.55 [1110.05–1255.23] | 1301.36 [1286.31–1399.12] | 1230.88 [1184.11–1234.12] |
| catalog-0 | 104.53 [95.41–118.23] | 61.31 [53.17–77.43] | 120.96 [107.73–151.50] | 75.29 [72.44–79.98] |
| catalog-128 | 106.81 [105.33–112.08] | 53.91 [51.48–83.69] | 131.30 [119.73–141.35] | 89.32 [77.28–90.48] |
| catalog-512 | 114.50 [104.29–115.22] | 61.05 [59.50–76.29] | 123.70 [115.77–151.83] | 83.10 [82.27–106.83] |
| readers-1 | 107.61 [104.02–115.72] | 58.63 [58.14–72.96] | 118.72 [114.77–138.34] | 84.85 [75.12–99.47] |
| readers-2 | 154.99 [150.33–156.24] | 71.89 [67.87–100.93] | 163.01 [131.02–166.25] | 82.45 [81.55–99.70] |
| readers-4 | 188.18 [173.22–193.47] | 95.31 [78.79–97.33] | 187.91 [184.88–196.50] | 120.18 [88.41–346.11] |
| combined | 1815.99 [1752.99–1864.42] | 1493.15 [1389.95–1740.76] | 1655.65 [1607.20–1685.26] | 1395.07 [1290.62–1428.33] |

Selected **warm per-label interval-union medians (ms)**. These columns overlap and
must not be summed; they are not exclusive CPU time.

| Filesystem / case | Replay restore | Reduce | Public tail | Protected append |
| --- | --- | --- | --- | --- |
| tmpfs / history-32 | 13.74 | 0.05 | 7.80 | 26.83 |
| tmpfs / history-512 | 136.13 | 0.24 | 8.87 | 38.68 |
| tmpfs / combined | 1178.97 | 1.17 | 103.55 | 41.90 |
| ext4 / history-32 | 13.40 | 0.05 | 7.12 | 43.40 |
| ext4 / history-512 | 117.39 | 0.21 | 8.56 | 135.86 |
| ext4 / combined | 1113.22 | 0.97 | 88.32 | 53.97 |

Compiled demo wall time includes process startup and its complete scripted workflow:

| Filesystem | Individual seconds | Median seconds | Min–max seconds |
| --- | --- | --- | --- |
| tmpfs | 26.533 / 22.490 / 27.477 | 26.533 | 22.490–27.477 |
| ext4 | 24.604 / 21.891 / 25.346 | 24.604 | 21.891–25.346 |

These demo values are not directly comparable with #397: different machine, Node/kernel,
supervision and source. No regression percentage or allowed overhead is inferred.

## Interpretation and follow-up

The largest histories and combined case make protected replay restoration a strong
candidate for deeper profiling. The `replay-restore` interval includes authentication,
input/sensitivity validation and event reconstruction, so these measurements cannot
choose between those internals. `reduceRun` itself is small in these fixtures. Growing
run count deliberately grows a full inventory's work; this is not a regression claim
about the daemon's bounded list API. Reader scaling measures overlapping calls in one
process, not multi-process contention or a throughput capacity limit.

At these sizes the unrelated-catalog results do not establish a stable cost curve:
sample spread and nonmonotonic medians prevent attributing a specific catalog bottleneck.
The source shows enumerations, but a source read is not a measured syscall count. Report
public operation counts and interval unions as supplied; do not sum overlapping phase
medians or use them as additive speedup estimates. Three repetitions on one VM cannot
establish a statistical confidence interval or a standing performance budget.

Next work belongs to existing **#408**: review operation-local instrumentation for key
reads, integrity checks, input/sensitivity validation, private catalog enumeration,
authentication/decoding and durable publication; then select an optimization from exact
before/after evidence and rerun the required freshness, authorization, fail-closed and
durability tests. No shared instrumentation seam was added here. Existing **#367** owns
restricted daemon list filtering; this store inventory fixture does not replace it.
No new issue was opened because the observed follow-ups already have those owners.

The physical-disk criterion remains **blocked** despite successful execution on a
disk-backed virtual filesystem: a QEMU device does not identify the physical media.
Storage-cold measurements and internal phase attribution are **blocked**, frozen
integration-candidate comparisons are **unrun**, and optimization/security-regression
acceptance remains **unrun**. The historical #397 allowance of 55.7% is neither a budget
nor a comparison point for this different host and workload. No unpublished candidate
is called main, and no newer read-snapshot behavior is inferred from an open PR.
