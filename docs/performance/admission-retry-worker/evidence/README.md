# Retained evidence

`scenarios.csv` maps stable R01–R25 IDs to every exact original Vitest case name.
The unchanged test/worker/fixture SHA-256s and source/tree identities are retained
in each paired provenance report. All runtime/manifests/lock/config files have
identical control hashes between base and candidate. Only the harness and new
compiler/regression differ in the owned code scope.

## Primary versus historical packets

- `paired-esm/`: primary three alternating-order pairs using the published ESM
  observer and supervisor. Raw test JSON/logs, process records, timings and
  provenance are gzip-compressed without changes. The local observations record
  fork-to-IPC-ready and fork-to-close intervals, not child CPU time. They include
  process creation, imports, store initialization and parent event scheduling.
- `samples.csv`: primary supervisor/file durations, counts and within-run median,
  minimum and maximum fork-to-ready observations. Do not sum process intervals:
  race workers overlap, and close intervals include deliberate barriers/contention.
- `paired/` and `samples-observer-cjs.csv`: earlier successful three-pair cohort
  with a CommonJS observer. It has the same helper/harness implementation and all
  25 cases/75 processes per run, but a different observation preloader. Retained
  separately, excluded from the primary summary. `observe-measured.cjs.gz` retains
  the exact historical observer matching its recorded hash.
- `observer-failure/`: first attempt's passing baseline 25-case report, source/tree
  provenance and elapsed sample. Process observations were not flushed from the
  Vitest worker; the supervisor stopped after this missing-evidence error. It is
  not a complete pair and is excluded from both cohort summaries.
- `feasibility/`: initial temporary emitter/probe, six alternating micro pairs and
  full observations. The first slower tsx sample is retained. This emitter lacks
  the final helper's hash verification, so its 207 ms preparation cost and micro
  startup results are feasibility evidence only. Neither cache emptiness nor pure
  compiler time was established; caches were recently populated and never flushed.
- `validation/`: focused 33-case Node 24/22 reports, both explicit 2-case CLI/ACP
  opt-in reports, typecheck/lint/format/design/clean/build outputs and command
  outcomes. The compiled-demo success retains its digest/length and exit record;
  raw synthetic output remains in task scratch. `closure-node*.json.gz` records
  120 input hashes, candidate content key and 109 emitted hashes on each Node.
  All emitted hashes and inputs match across Nodes; target Node contributes to the
  content key. The official Node 22.23.3 archive checksum verification is retained.
- `development/` and `development-failures.json`: original 25/25 smoke and 8/8
  regression, successful frozen baseline install, early typecheck, offline metadata
  failure and initial invalid tsx loader resolution. The two early error strings
  are explicitly reconstructed transcript summaries, not claimed raw log files.
  First lint failed on retained probe artifacts and CommonJS observer imports;
  `validation/lint-first.log.gz` retains it and final whole lint passed unchanged
  policies after scoped cleanup/ESM conversion. No actual test failure is omitted.
- `toolchain.json`: exact Node 24.21.0 binary hash, pnpm 12.4.2 (including child
  Node version), Vitest 5.0.2, tsx 4.23.15 and observed Linux/cgroup allocation.
- `SHA256SUMS`: digests of every other evidence file, excluding itself.

All comparative test reports contain the identical 25 passed names, zero failures,
skips or todo. Each complete cohort observes 450 fresh worker PIDs, 126 SIGKILL
exits and 324 normal exits. No credential/store/key/fixture directory is published.
The matrix and the source diff prove assertion preservation; these measurements
are local cloud evidence, not whole-CI, homelab, physical-media or native acceptance.

The Node 24 timing supervisor uses blocking waitpid with an independent watchdog.
No Python communicate/wait timeout polling is included. Fork/ready/close timestamps
still include event-loop scheduling and observation overhead; they are not isolated
compile, CPU, persistence or process-only execution measurements. Build/hash/setup/
cleanup are included in whole-file supervisor elapsed and must not be added again.

Whole ordinary/coverage suites and coverage threshold verdicts are not established
by these focused local runs. Those full acceptance gates remain with normal PR CI;
Node 22 paired performance and homelab replication remain unmeasured. #408's private
phase, physical-media/power-loss and true storage-cold evidence remains open.
