# Retained issue 510 evidence

All reports describe synthetic disposable workloads. No token or credential
record is retained. JSON/logs are compressed with deterministic gzip (`mtime=0`).
Use `gzip -dc <file>` to inspect them. Checksums are in `SHA256SUMS`.

- [samples.csv](samples.csv): every paired supervisor and per-file elapsed time,
  order, variant and outcome. File timings came from the serial combined runs.
- [scenarios.csv](scenarios.csv): all 60 stable full names and all six pass statuses.
- [toolchain.json](toolchain.json): official archive URLs and archive/binary hashes,
  plus the existing pnpm 12.4.2 entry hash.
- `micro/` and `suite/`: raw provenance, emitted hashes, timing records and complete
  Vitest reports/logs. `micro-prechange/` retains the initial same-checkout probe.
- `validation/`: frozen installs, clean builds, whole statics, both Node gates,
  explicit CLI/ACP reports, emitted-demo logs and the baseline permission probe.
  Node 24's full JSON contains its collected coverage map; failed tests prevented
  Vitest's final coverage summary/threshold verdict. Both aggregate exit-1 results
  are retained, including the original unchanged store failure.
- `development/`: the two failed authoring attempts for the added regression.
  The corrected regression report is under `validation/`.

The protected-store baseline probe filtered twelve other cases intentionally; its
one failure is evidence of the baseline umask assumption, not a full baseline run.
The full gates were each run once. Three opt-in skips in each full report are
accounted for in the main report; both retry cases passed in separate no-skip runs.

The measurement supervisor is [../measure.py](../measure.py). Aggregate gate
commands, supervisor limits, exits and wall times are in `gates-node22.json.gz` and
`gates-node24.json.gz`; their final source fixture/consumer/build hashes are in the
matching `node*-artifacts.json.gz`. Publication only adds the report/evidence after
the implementation commit measured and validated in those packets.
