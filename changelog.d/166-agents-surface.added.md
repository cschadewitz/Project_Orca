- **app:** the Agents surface. Every configured agent as a health card, grouped by the host
  it is spawned on, with the handshake state as a glyph and a word, both of its timestamps,
  the round trip of the last successful handshake, and — on a card that is down — the error
  that explains it. An agent nothing has contacted reads `unknown` and says so ("not
  contacted since the daemon started"): health is tracked in the daemon's process and never
  persisted, so that is the honest answer rather than a missing one. The list is read once
  and every later change arrives as an `agent.changed` push; nothing polls and nothing
  re-reads. What is claimed right now travels with the same read and is shown beside the
  agents, as the work item and the run holding it.
