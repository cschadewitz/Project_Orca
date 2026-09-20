- **agents:** handshake health per agent (#222). `AgentRegistry` now carries an
  `AgentHealthTracker`: every agent session the interpreter opens records a successful
  handshake with its round trip, and every spawn or handshake that fails records the
  opposite, so the Agents surface has a state to read instead of inventing one. The states
  are `unknown`, `ok`, `degraded` and `down`. `degraded` means the handshake succeeded only
  after a retry — there is deliberately no latency threshold, because ORCA has no data yet
  for a defensible round-trip bound over ssh; the round trip is recorded either way so one
  can be added later. Nothing polls: health only ever reflects sessions a run asked for.
  Health is held in memory only, so a restarted daemon reports every agent as `unknown`
  until it is next contacted rather than claiming `ok`.
