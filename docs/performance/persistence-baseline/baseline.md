# Main persistence baseline, 2026-10-03

This establishes bounded workloads and a measured baseline for #423. It does not
implement an optimization or complete parent #408's acceptance. The full method,
limits and rerun commands are in [README](README.md); the sanitized raw measurements
and compiled hashes are in the [evidence packet](evidence/README.md).

## Identity and execution

Fetched `origin/main` and used Kepler's sync operation before editing. Main and the
approved issue baseline both resolved to `e94bf699d9f3000de8822ed3434c1dce92b6ce19`, tree
`e2bfc2d786f4458cd3e635f94766698d7faced70`; no later rebase or peer-branch import was needed.
Runtime sources were unchanged. Both final suites ran from clean benchmark commit
`f06202636da035fc69cbfff52a5b160112b73f1a` (empty `ownedDiff`), whose harness hashes are in
each report. That commit is a benchmark/docs branch commit, **not main**; it compiles the
approved main runtime bytes. Later `origin/main` commits change runtime sources, so this
branch was deliberately not rebased: the runner would refuse them as unapproved changes.

The earlier, unbalanced-order packets (see below) used benchmark commit
`40d6fc876a9ff5333d1e6a5f56260edaf519469b` for tmpfs and that checkout plus the then
uncommitted demo-isolation fix (committed as `019d2f5`) for ext4. `f062026` differs from
`019d2f5` only in the cache-order schedule, its self-check and the untimed restoration
oracle; store fixtures and phase timers are unchanged.

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
  --output "$OUT/tmpfs-balanced" --seed 423
node tools/benchmarks/persistence-baseline/run.js --profile baseline --scratch "$PWD" \
  --output "$OUT/ext4-balanced" --seed 423
```

`$OUT` was a session scratch directory outside the checkout, so the clean-tree check was not
disturbed; reports were compressed into `evidence/` afterwards (Python `gzip`, level 9,
`mtime=0`, matching the earlier packets). Choose
new output names when rerunning; the runner refuses existing directories. Seed defaults to
**423**. Filesystem suites ran sequentially, after all eight self-checks passed at the same
commit. Concurrent host load was not controlled beyond keeping this task's own test and
benchmark processes sequential: the 1-minute load average was 0.45 before the tmpfs suite,
2.51 between suites and 2.86 after ext4, with other agent sessions active on the VM. The
evidence is a local diagnostic, not a CI budget.

## Outcomes and retained failures

- Harness self-checks: **8 passed**, covering the Git discovery boundary, bounds, timeout/output
  failure accounting, dimension independence, rotation, the executed per-case cache-order
  schedule for both profiles, interval union, summary exclusion of failures, and compiled
  protected-fixture/concurrent-reader oracles including every restored event.
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
- The resulting tmpfs and isolated ext4 suites both **passed** every oracle (26 fixtures, 156
  samples, six demos) but are **unbalanced-order** evidence. Review found that cache order
  was keyed on round plus the case's rotated position, which cancels the rotation for most
  cases: **11 of 13 cases** ran the same process-cold/warm order in all three rounds (for
  example, history-512 and combined were process-cold first every time). Cache order was
  therefore confounded with case identity, and the alternating-order method was **unmet**.
  The fix keys order on each case's stable plan index and tests the executed schedule. The
  two packets are retained unchanged under `evidence/unbalanced-order/` with a per-round
  order table and are excluded from final scaling. Their individual timings remain valid
  observations; the defect does not establish a runtime regression. Both suites were then
  recollected with the corrected harness.

The detailed final outcomes and scaling data follow below. No synthetic state, generated
execution keys or raw demo diagnostics are retained.

## Final measured results

The corrected tmpfs and isolated ext4 suites **passed**: **26 fixtures, 156 read/append
samples and six compiled scripted demos** in total. Each case/cache/filesystem has three
successful observations, and every case's first cache condition reverses between adjacent
rounds in both packets (`evidence/cache-order.csv`). Both forced builds passed and produced
the same compiled artifact manifest as the earlier packets:
`576a75823d404e992d4534327645804498bb32259482b48984e6badaf1ba774d`
(SHA-256 of raw `artifacts.json`). Both runs verified branch preservation.
All generated scratch state was removed. Fixture allocation before cleanup was tmpfs: 18,472,960 bytes / 4,168 files, ext4: 18,472,960 bytes / 4,168 files.
Total suite times were tmpfs: 222.31 s, ext4: 272.14 s.

Whole measured read-plus-append workload **median [min–max] in milliseconds**. Process-cold
and warm remain separate; process startup, warmup, fixture copy and final oracle are
excluded. Full precision, spread and individual samples are in the packet.

| Case | tmpfs process-cold | tmpfs warm | ext4 process-cold | ext4 warm |
| --- | --- | --- | --- | --- |
| history-32 | 103.92 [97.11–105.43] | 61.40 [56.32–63.71] | 115.90 [111.99–116.93] | 70.07 [65.73–71.47] |
| history-128 | 173.90 [168.08–186.17] | 81.12 [76.53–86.87] | 217.53 [187.70–224.57] | 93.18 [91.97–114.79] |
| history-512 | 356.25 [328.74–357.69] | 185.16 [172.50–203.36] | 346.74 [332.54–370.59] | 200.83 [200.55–261.88] |
| runs-1 | 104.97 [95.08–109.15] | 56.08 [52.77–68.88] | 118.02 [114.00–122.93] | 77.48 [75.03–163.44] |
| runs-8 | 332.27 [301.47–337.26] | 227.92 [203.42–230.49] | 337.37 [331.27–379.34] | 257.33 [245.67–261.89] |
| runs-32 | 1175.60 [1102.53–1180.36] | 1045.71 [1032.76–1116.27] | 1265.55 [1206.24–1437.23] | 1165.18 [1165.06–1183.07] |
| catalog-0 | 100.19 [97.59–102.06] | 53.52 [51.80–69.11] | 119.25 [112.72–122.87] | 72.80 [69.57–200.71] |
| catalog-128 | 105.74 [95.71–114.30] | 58.43 [56.33–65.60] | 108.09 [106.63–116.11] | 77.17 [71.47–154.83] |
| catalog-512 | 106.68 [92.93–114.50] | 65.32 [57.96–72.50] | 123.98 [119.06–162.64] | 78.06 [77.18–95.12] |
| readers-1 | 96.46 [96.04–105.54] | 60.48 [51.76–66.61] | 118.82 [113.56–142.99] | 75.49 [69.02–82.73] |
| readers-2 | 131.90 [120.66–152.44] | 67.46 [62.00–73.38] | 144.51 [140.08–147.55] | 74.73 [69.24–106.68] |
| readers-4 | 173.00 [162.62–191.14] | 81.86 [69.94–85.29] | 192.83 [180.44–194.31] | 93.77 [85.93–104.39] |
| combined | 1528.03 [1503.66–1530.80] | 1316.36 [1285.79–1338.64] | 1552.09 [1539.64–1609.62] | 1328.36 [1254.86–1347.29] |

Selected **warm per-label interval-union medians (ms)**. These columns overlap and
must not be summed; they are not exclusive CPU time.

| Filesystem / case | Replay restore | Reduce | Public tail | Protected append |
| --- | --- | --- | --- | --- |
| tmpfs / history-32 | 13.12 | 0.05 | 7.24 | 30.08 |
| tmpfs / history-512 | 119.91 | 0.20 | 7.38 | 37.73 |
| tmpfs / combined | 1062.94 | 0.85 | 89.68 | 35.06 |
| ext4 / history-32 | 11.75 | 0.05 | 5.78 | 42.85 |
| ext4 / history-512 | 118.82 | 0.23 | 7.41 | 53.85 |
| ext4 / combined | 1046.75 | 0.90 | 80.27 | 46.76 |

Compiled demo wall time includes process startup and its complete scripted workflow:

| Filesystem | Individual seconds | Median seconds | Min–max seconds |
| --- | --- | --- | --- |
| tmpfs | 21.519 / 21.405 / 21.339 | 21.405 | 21.339–21.519 |
| ext4 | 26.589 / 25.378 / 25.347 | 25.378 | 25.347–26.589 |

These demo values are not directly comparable with #397: different machine, Node/kernel,
supervision and source. No regression percentage or allowed overhead is inferred.

Several medians are lower than in the unbalanced-order packets (for example tmpfs combined
process-cold, 1528.03 versus 1815.99 ms), while others are higher. Runtime bytes are
identical; host load, session, cache order and the retained-reference oracle all differ, so
no difference between the two packet sets is a speedup, regression or attributable effect.

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
is called main, and no newer read-snapshot behavior is inferred from an open PR. These are
`e94bf699` baseline observations on tmpfs and QEMU ext4 with recently copied OS pages, so
#408 stays open: physical-media/power-loss evidence, storage-cold measurements, private
phase attribution, newer read-fix performance and an evidence-based regression budget
remain unproven.
