- **daemon:** Delegated steps respect the remote daemon's session cap. A delegating agent
  (`type: orca-daemon`) never holds more sessions open to one remote than that remote's own
  `limits.maxAgentSessions`, as its `hello` reports it; the rest wait with `step.waiting` on
  `agent-slot` and a detail naming the remote. An uncapped remote stays unlimited.
