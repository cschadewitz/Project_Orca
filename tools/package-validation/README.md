# Package validation (Windows/Linux)

Offline, static inspection of release artifacts against an explicit candidate manifest.
The test plan, inputs and runtime procedures are in
[docs/archive/preparation/windows-linux-release-artifacts](../../docs/archive/preparation/windows-linux-release-artifacts/README.md).

```sh
node tools/package-validation/inspect.js --candidate candidate.json --source <checkout-at-commit> \
  --artifact <file> [--artifact <file> ...] [--allow-partial] [--out report.json]
```

- `formats.js` — bounded readers for tar.gz, zip, ASAR, PE, ELF, `latest-ARCH.yml` and
  blockmaps. Read-only; refuses what it does not understand.
- `inspect.js` — the checks, the candidate/source identity binding and the report.

Tests: `tools/test/package-validation/`, on benign synthetic fixtures only. Nothing here
launches, installs, signs, verifies signatures, publishes or uses the network. A
`consistent` report is not candidate acceptance. macOS artifacts are out of scope.
