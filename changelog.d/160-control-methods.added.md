- **protocol/daemon:** the control methods (protocol 1.4) — `inputs.answer`, `runs.resume`,
  `runs.cancel` and `runs.start`. The daemon takes each run's single-writer lease before it
  appends and refuses a run another live process holds, with that holder's pid and host,
  rather than waiting on it. Four new error codes say which refusal it was:
  `INPUT_ANSWERED`, `INPUT_OPTION_UNKNOWN`, `RUN_NOT_WAITING`, `RUN_LEASED_ELSEWHERE`.
- **cli:** `orca serve` drives runs by default and `--read-only` opts out, leaving the
  control methods out of the dispatch table *and* out of `hello.methods` and dropping
  `runs.control` from `hello.capabilities`. The port carries no authentication: any local
  process can call them, and the lease guards against a second writer rather than against a
  caller — said plainly in `orca serve --help` and in ADR 0008.
- **cli/daemon:** `orca answer` and `inputs.answer` are one shared function, so the CLI and
  the wire cannot drift on what answering a gate does.
