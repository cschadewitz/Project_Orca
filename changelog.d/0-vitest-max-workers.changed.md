- **tests:** the suite caps itself at four workers (`maxWorkers`, overridable with
  `VITEST_MAX_WORKERS`). Vitest forks one per core by default, so the suite's memory
  footprint scaled with whatever machine it ran on and nothing bounded what two concurrent
  runs cost. Measured on an 8-core box: 8 workers is 45s at 3,249 MB peak, 4 is 50s at
  2,217 MB — 11% slower for a third less memory, since the suite is startup- and I/O-bound
  well before it is CPU-bound.
