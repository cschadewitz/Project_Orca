- **protocol/daemon:** `runs.events` takes a `stepRunId` filter beside `types`, which is how a
  step's output is read (#158). A step's output *is* the `agent.update` events it appended, so
  it is one filter on one method rather than the `steps.output` method the issue sketched — a
  second method would have meant a second cursor semantics for file mode and the read-only
  daemon to support. The filters are an AND, run-level events match no step, and the cursors
  stay the run's own sequence numbers, so paging back from a page's `prevCursor` crosses a trim
  boundary with no gap and no duplicate. One consequence worth knowing: a client buffers
  **events, not lines** — one `agent.update` renders many lines, so the design's "last 50,000
  lines" is a count of events on this wire.
