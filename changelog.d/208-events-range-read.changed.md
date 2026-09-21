- **store:** `EventStore.readRange(runId, { after, before, limit, types, match })` reads one
  page of a run's log, and `lastSeq(runId)` reads the end of it. The JSONL store scans to the
  page a chunk at a time and stops there — forward from the start for `after`, backward from
  the end for `before` — so neither the file nor its parsed events are ever held whole.
- **daemon:** `runs.events` and a subscription resuming from a cursor take that page rather
  than reading the whole log and cutting it in memory. Scrolling a run whose log is tens of
  thousands of `agent.update` lines now costs a page; the answers are unchanged.
