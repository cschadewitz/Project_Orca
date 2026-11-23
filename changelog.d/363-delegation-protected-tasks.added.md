- **daemon:** A delegated step whose task holds a value the run protects (a `sensitive` launch
  input or a secret read for the run) is admitted on the worker with its prompt variable
  protected (`runs.admit` `sensitiveVars`, protocol 2.11): encrypted there and redacted from
  the worker's run views, events and logs. A worker that cannot take it is refused the step
  before anything is sent. An artifact body sent back redacted is checked against the size and
  digest the worker reports for it (`artifacts.get` `redacted`) (#363).
