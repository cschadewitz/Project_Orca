- **app:** the command palette lists objects. Navigation carries the ten most recent runs and
  the configured agents with their handshake health; Search covers step and artifact names.
  Every row is a canonical `orca://` URL opened through the route table, which is what keeps
  one resolver rather than three, and nothing polls: each source reads once and a `run.changed`
  or `agent.changed` drops what it holds. Event text and artifact contents are not searched —
  the protocol has no text-search method, and scanning every log in the store per keystroke is
  not a search.
