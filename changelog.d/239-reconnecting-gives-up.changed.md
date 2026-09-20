- **app:** `reconnecting` becomes `disconnected` at backoff saturation — three consecutive
  failures at the 5s cap, about twenty seconds of silence. Against a daemon that has gone for
  good the status bar no longer reads "reconnecting… 4m" indefinitely. The rule is a fact about
  the retry loop rather than a stopwatch, so it survives a change to the backoff, and the
  subscription keeps retrying: this changes what is rendered, not what is attempted.
