- **daemon:** A delegated step whose task holds a value the run protects (a `sensitive` launch
  input or a secret read for the run) is admitted on the worker with its prompt variable
  protected and each original value sent for redaction (`runs.admit` `sensitiveVars` and
  `protectedValues`, protocol 2.11): encrypted there, and each value redacted on its own from
  the worker's run views, events, logs and served artifact bodies. The worker's support is
  checked again right before every admission; one that cannot take it is refused the step
  before anything is sent. An artifact body sent back redacted is held to the size limit as
  sent, and checked against the size and digest the worker reports for it (`artifacts.get`
  `redacted`) (#363).
