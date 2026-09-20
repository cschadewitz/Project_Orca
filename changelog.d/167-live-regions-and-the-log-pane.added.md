- **app:** the app has one polite live region, and the output pane is a `log` region that
  never speaks. The announcer is mounted once by the chrome and fed from the notification
  stream every surface already listens on — step transitions and terminal states only, in the
  design's own words ("build step failed, 3 attempts"), with a step's node name remembered
  from the frame that introduced it and its id said when no frame ever named it. The output
  pane now carries `role="log"` and the name of the step it belongs to, with an explicit
  `aria-live="off"` beside it: the role is what puts a step's output in the region list a
  person navigates by, and the `off` is what keeps forty lines a second out of their ear
  (RULES.md rule 11).
- **app:** an interruption card is named by its tier first — "gate, Ship release 1?" — the
  same status-first ordering the run rows and the agent cards already take, which is what
  makes a greyscale screenshot and a screen reader say the same thing.
