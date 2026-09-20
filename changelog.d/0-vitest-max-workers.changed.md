- **tests:** the suite caps itself at four workers, or the machine's own default where that
  is lower (`VITEST_MAX_WORKERS` overrides). Vitest's default is one worker per core less
  one, so the suite's memory footprint was a property of whichever machine it ran on and
  nothing bounded what two concurrent runs cost. Measured on an 8-core box: 7 workers is 45s
  at 3,249 MB peak, 4 is 50s at 2,217 MB — 11% slower for a third less memory, since the
  suite is startup- and I/O-bound well before it is CPU-bound. The cap can only reduce
  concurrency, never add to it, so a 2- or 4-core CI runner is unaffected.
