- **app:** Attention, its sidebar badge and Machines show the same waiting count. Attention
  now reads the daemon's list again a moment after any change that can move it, so an ask its
  live updates missed, or one a run closed without an answer, no longer leaves it one off
  (#1213).
- **app:** the status bar no longer shows a stale "event N". That number was the plan
  journal's sequence number leaking into the store-wide stream's cursor; the event cursor is
  per run and stays beside the run, in its timeline (#1213).
- **daemon:** `inputs.list` no longer fails pending-correction discovery for a run that is busy
  writing events. It observes the run again, and reports one that never settles as an
  omission, so Attention says part of the list is unavailable instead of "could not be
  refreshed". When a refresh really fails, the notice now says to choose Refresh corrections
  (#1213).
