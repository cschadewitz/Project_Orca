- **app:** a run that ended cancelled no longer reads as a run that failed. The timeline's
  gutter derived its marker from `run.completed` by treating every outcome that was not
  `success` as a failure, but `RunOutcome` has three values — so a run somebody stopped on
  purpose drew the same red tick as one that broke, while the *same* run ending through
  `run.cancelled` drew it correctly. The two now agree, which matters because the gutter is
  what a long run is scanned with (#249).
