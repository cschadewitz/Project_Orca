- **app:** every write the daemon serves is in the command palette, as a keyless action on
  the object in focus: **Answer `<gate>`: `<option>`** for each option a selected card
  offers, **Cancel** and **Resume** on the run a card is waiting on or the run selected on
  Runs, **Start a run**, and on the Plan surface **Waive dependency on `<target>`**,
  **Decide `<key>`**, **Reopen decision `<key>`**, **Update risk `<key>`** and **Release
  claim on `<item>`**. Nothing was added to the chrome of any screen: the palette is the
  only place a phase-2 write has to be discoverable.
- **app:** the answer rows are the card's own options in the card's own order — the
  destructive one last, as `bindOptions` puts it — and they call the same `inputs.answer`
  path the card does. A free-text ask gets no rows: there is nothing to type into in a list
  of commands. "Always" stays on the card, where the button can say what it will actually
  promise.
- **app:** a destructive row confirms inside the palette rather than in a dialog. Choosing
  it swaps its label for the confirmation — *Cancel run-42 — confirm* — in the danger tone,
  and a second **Enter** commits; typing, moving the selection or **Esc** disarms it and
  nothing has been sent. A destructive row also never sorts first, for the same reason a
  gate's destructive option is never bound to `1`.
- **app:** **Start a run** replaces the palette's list with a picker of the daemon's
  workflows — name, id, version and node count — and starts the chosen one with the
  workflow's own vars, then opens the new run through the route table. **There is no vars
  form**: nothing in the protocol says what a workflow's inputs are called, so the row says
  what it starts with rather than offering fields it would have had to invent.
- **app:** a write the daemon does not serve has no row at all, and a daemon that is not
  answering keeps the rows with `useWritability()`'s own sentence beside them — absent where
  ORCA is a viewer, disabled with a reason where it is waiting.
- **app:** `runs.start` reaches the app for the first time: the daemon has served it since
  protocol 1.4 and nothing could call it until there was a workflow picker.
