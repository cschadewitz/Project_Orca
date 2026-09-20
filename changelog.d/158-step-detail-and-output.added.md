- **app:** step detail and the agent output pane. A step says its node, attempt, agent, host
  and duration, lists the artifacts it produced as chips, folds its `agent.update` events into
  tool-call rows — arguments, result, and the permission ask that settled it — and streams its
  output as fixed-height lines at `row-log` over the list substrate. The stream follows or is
  held, offers **Jump to latest** with the count of new lines, buffers the last 50,000 events
  and pages backwards across the trim boundary with **Load earlier output**; `G`, `⇧G`, `/`
  and `N` / `⇧N` are on the keyboard map in the `stream` scope. A reconnection leaves
  `◷ paused — reconnecting` and `── reconnected hh:mm:ss ──` inline, where the gap fell. With
  a run selected and no step, the same pane is a minimal run summary. No cost and no token
  count: ORCA cannot supply either, so the header's sixth metric slot stays empty.
