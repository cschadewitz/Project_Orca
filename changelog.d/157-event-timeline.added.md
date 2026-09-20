- **app:** the event timeline, under the run tree: the selected run's log, paged backwards
  from `runs.events` and tailed forwards from `event.appended` and `agent.update`. A
  coalesced batch of agent updates is one row and says how many; a gate a policy settled
  renders quietly and names `gate:auto` rather than a condition the event does not carry.
  The sticky header shows the current step and the run's own cursor — "as of event *n*" —
  because sequence numbers are per run and the status bar's store-wide cell has no single
  number to show.
