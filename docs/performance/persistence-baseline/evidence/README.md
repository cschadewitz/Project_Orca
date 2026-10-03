# Evidence packet

The raw runner JSON and artifact manifests are retained as deterministic gzip files
(`mtime=0`). Decompression returns the original bytes; the artifact-manifest digest
inside each report refers to those uncompressed bytes. `SHA256SUMS` hashes the compressed
packet files and the readable scaling table. Do not reformat decompressed JSON before
checking its hash.

```sh
cd docs/performance/persistence-baseline/evidence
sha256sum -c SHA256SUMS
gzip -dc tmpfs/report.json.gz > /tmp/persistence-report.json
gzip -dc tmpfs/artifacts.json.gz | sha256sum
```

`scaling.csv` presents every final case/cache/filesystem group, including sample count,
median and min/max/spread. Raw reports retain every ordered sample and operation count,
per-label interval unions, whole-worker and measured-workload wall times, setup/demo
outcomes, environment, source and artifact identity, and cleanup.

- `tmpfs/`: final baseline, OS cache uncontrolled.
- `ext4/`: final baseline on a QEMU virtual block device, unchanged durability paths;
  physical-media validation is blocked.
- `development/`: earlier failed attempts, preserved separately and excluded from the
  final scaling table. These used earlier harness revisions whose hashes are in their
  reports where preflight reached that stage. They are development diagnostics, not
  measurements of the final harness. The initial sandbox failure never reached build
  or benchmark execution.
- `self-checks.txt`: final harness self-check result.
- `backing.txt`: observed virtual block-device model and machine type, no serial numbers.

See [baseline findings](../baseline.md) for commands, interpretation, failed-attempt
history and criteria that remain unmet. No key, private store, canary payload, provider
transcript or full process environment is retained.
