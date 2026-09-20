- **cli:** `orca --version`, the `orca serve` banner and `hello.orcaVersion` report the
  release version — the root `package.json`, the one the tag and this changelog carry —
  instead of `@orca/cli`'s own `0.1.0`, which no release has ever been. Observable output
  changes: a `v0.4.0` daemon now announces `orca daemon 0.4.0` where it announced
  `orca daemon 0.1.0`, and the desktop app's connection details show the same string.
  `orca --version` is also a flag the CLI now answers at all: it printed the usage text and
  exited 1.
