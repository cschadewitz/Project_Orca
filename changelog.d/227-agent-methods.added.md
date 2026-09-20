- **protocol/daemon:** `agents.list` and `agents.ping`, and the `agent.changed` push behind
  them. Both are answered by a `--read-only` daemon: neither touches a run, a lease or a log.
  `agents.list` reports every *configured* agent — `unknown` for one nothing has contacted,
  never a fabricated default — alongside the claims that say what is being worked right now.
- **agents:** two timestamps per agent instead of one. `lastHandshakeAt` is when ORCA last
  established a connection; `lastSeenAt` moves with the agent's output, so a pooled per-run
  session that handshook an hour ago and spoke a second ago can say both. `agent.changed`
  fires from a listener on the health tracker — a handshake succeeding or failing, never the
  per-batch `lastSeenAt` refresh.
- **cli:** `orca ping <agentId>` calls the daemon's `agents.ping` when one answers on the
  configured address, so the result lands where the Agents surface can see it. With no
  daemon it handshakes in-process as before and says, in those words, that it recorded
  nothing.
