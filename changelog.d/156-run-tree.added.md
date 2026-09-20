- **app:** the Runs surface is a run tree. A run opens into its step groups, its earlier
  attempts, its child runs and the fan-out branches that never ran, from one `runs.get` per
  run and then `run.changed` and `step.changed` — never `agent.update`. `→`, `←`, `⇧→`,
  `Enter` and `F` are registered in the `run-tree` scope beside the substrate's movement
  keys, indentation stops at six levels with the ancestor chain in the sticky header, and a
  running run draws an indeterminate meter: ORCA has no completion percentage and none is
  invented.
