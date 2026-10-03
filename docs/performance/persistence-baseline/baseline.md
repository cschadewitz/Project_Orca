# Main persistence baseline, 2026-10-03

This establishes bounded workloads and a measured baseline for #423. It does not
implement an optimization or complete parent #408's acceptance. The full method,
limits and rerun commands are in [README](README.md); the sanitized raw measurements
and compiled hashes are in the [evidence packet](evidence/README.md).

## Identity and execution

Fetched `origin/main` and used Kepler's sync operation before editing. Main and the
approved issue baseline both resolved to `e94bf699d9f3000de8822ed3434c1dce92b6ce19`, tree
`e2bfc2d786f4458cd3e635f94766698d7faced70`; no later rebase or peer-branch import was needed.
Runtime sources were unchanged. The harness was uncommitted during execution; its exact
file hashes are in each report and match the files delivered in this PR.

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
  --output docs/performance/persistence-baseline/evidence/ext4
```

Choose new output names when rerunning; the runner refuses existing directories. Seed
defaults to **423**. Filesystem suites ran sequentially. Self-checks ran before the final
tmpfs suite. Concurrent host load was not controlled beyond keeping this task's own test
and benchmark processes sequential; the evidence is a local diagnostic, not a CI budget.

## Outcomes and retained failures

- Harness self-checks: **6 passed**, covering bounds, timeout/output failure accounting,
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

The detailed final outcomes and scaling data follow below. No synthetic state, generated
execution keys or raw demo diagnostics are retained.

## Final measured results

Both final filesystem suites **passed**: **26 fixtures, 156 read/append samples and six
compiled scripted demos** in total. Each case/cache/filesystem has three successful
observations. Both forced builds passed and produced the same compiled artifact manifest:
`576a75823d404e992d4534327645804498bb32259482b48984e6badaf1ba774d` (SHA-256 of raw `artifacts.json`).
All generated scratch state was removed. Fixture allocation before cleanup was tmpfs: 18,472,960 bytes / 4,168 files, ext4: 18,472,960 bytes / 4,168 files.
Total suite times were tmpfs: 258.65 s, ext4: 316.92 s.

Whole measured read-plus-append workload **median [min–max] in milliseconds**. Process-cold
and warm remain separate; process startup, warmup, fixture copy and final oracle are
excluded. Full precision, spread and individual samples are in the packet.

| Case | tmpfs process-cold | tmpfs warm | ext4 process-cold | ext4 warm |
| --- | --- | --- | --- | --- |
| history-32 | 104.86 [99.91–111.24] | 59.96 [53.23–66.13] | 117.22 [114.16–119.00] | 74.79 [67.46–92.61] |
| history-128 | 190.39 [189.18–198.26] | 85.72 [83.87–91.19] | 200.07 [197.14–217.52] | 96.07 [92.17–103.35] |
| history-512 | 396.72 [385.47–397.92] | 205.60 [202.36–209.97] | 396.63 [373.95–412.25] | 222.34 [205.65–286.96] |
| runs-1 | 120.50 [112.51–156.54] | 72.96 [67.56–85.25] | 127.04 [122.70–135.45] | 72.74 [70.92–88.26] |
| runs-8 | 411.62 [332.40–414.30] | 247.99 [228.50–263.14] | 434.70 [433.48–485.96] | 300.77 [275.99–313.40] |
| runs-32 | 1290.34 [1199.12–1313.97] | 1155.55 [1110.05–1255.23] | 1345.89 [1245.86–1389.52] | 1470.79 [1381.43–1480.42] |
| catalog-0 | 104.53 [95.41–118.23] | 61.31 [53.17–77.43] | 123.11 [116.12–132.20] | 69.57 [66.72–71.58] |
| catalog-128 | 106.81 [105.33–112.08] | 53.91 [51.48–83.69] | 122.26 [111.43–132.88] | 78.07 [75.46–81.43] |
| catalog-512 | 114.50 [104.29–115.22] | 61.05 [59.50–76.29] | 129.92 [111.81–160.36] | 83.93 [78.44–89.66] |
| readers-1 | 107.61 [104.02–115.72] | 58.63 [58.14–72.96] | 130.56 [105.94–133.99] | 73.84 [69.62–78.33] |
| readers-2 | 154.99 [150.33–156.24] | 71.89 [67.87–100.93] | 144.90 [141.03–148.88] | 78.95 [75.88–90.51] |
| readers-4 | 188.18 [173.22–193.47] | 95.31 [78.79–97.33] | 216.04 [180.55–219.62] | 102.46 [98.81–103.10] |
| combined | 1815.99 [1752.99–1864.42] | 1493.15 [1389.95–1740.76] | 1810.65 [1761.12–2007.65] | 1513.87 [1368.63–1682.25] |

Selected **warm per-label interval-union medians (ms)**. These columns overlap and
must not be summed; they are not exclusive CPU time.

| Filesystem / case | Replay restore | Reduce | Public tail | Protected append |
| --- | --- | --- | --- | --- |
| tmpfs / history-32 | 13.74 | 0.05 | 7.80 | 26.83 |
| tmpfs / history-512 | 136.13 | 0.24 | 8.87 | 38.68 |
| tmpfs / combined | 1178.97 | 1.17 | 103.55 | 41.90 |
| ext4 / history-32 | 13.93 | 0.05 | 7.73 | 41.06 |
| ext4 / history-512 | 133.90 | 0.23 | 9.53 | 60.30 |
| ext4 / combined | 1217.82 | 1.31 | 100.27 | 48.68 |

Compiled demo wall time includes process startup and its complete scripted workflow:

| Filesystem | Individual seconds | Median seconds | Min–max seconds |
| --- | --- | --- | --- |
| tmpfs | 26.533 / 22.490 / 27.477 | 26.533 | 22.490–27.477 |
| ext4 | 27.409 / 26.384 / 27.411 | 27.409 | 26.384–27.411 |

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
