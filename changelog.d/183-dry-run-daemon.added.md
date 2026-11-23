- **daemon:** `workflowDrafts.dryRun` runs a dry run of your own draft, at the revision you name,
  with fixtures for agent turns and gate answers, and answers with what it did: the choices made,
  the branches never taken and what was assumed (#183, protocol 2.9). `runs.dryRunReport` reads
  that report again. Dry runs are marked `dryRun` on their rows and left out of `runs.list`
  unless asked for, and one left unfinished by a stopped daemon is cancelled on the next start.
