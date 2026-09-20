- **app:** `inputs.answer`, `runs.cancel` and `runs.resume` on the preload bridge, and an
  `alerts` channel beside it for the OS-notification half. `runs.start` is deliberately not
  there: starting a run needs a workflow picker the app does not have yet (#178).
