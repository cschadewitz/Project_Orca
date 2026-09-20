- **protocol/daemon:** `artifacts.list` and `artifacts.get` — the artifact index filtered by
  run, name, kind or producing step, and one artifact with its body (#159). `version` is
  monotonic per (run, name), so asking `artifacts.list` for one name in one run is the version
  list the docked panel steps through, and `artifacts.get` takes either an `artifactId` or the
  `runId`/`name`/`version?` triple a deep link carries. A body that is not text, or is past the
  call's `maxBytes`, is declined with the reason rather than served or refused: the panel still
  shows what the artifact is. Both are in `READ_METHODS`, so `hello` advertises them and a
  read-only daemon answers them; protocol version is now 1.3.
