- **cli/daemon:** the note on an answered gate is recorded in the run's log. `orca answer`
  takes `--note <text>` and `inputs.answer`'s existing `note` reaches `human.answered`
  instead of the daemon's own logger, so a client may show it as something the run holds —
  which the field's documentation previously had to tell it not to do. The run still branches
  on the option id alone; the note is the record of why.
