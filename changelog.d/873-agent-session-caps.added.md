- **engine:** optional caps on concurrent agent sessions: `limits.maxAgentSessions` for the
  whole daemon, `agents[].maxSessions` for one agent and `hosts[].maxSessions` for one host.
  Unlimited unless set. A step that would exceed a cap waits before it opens a session, shown
  as blocked with the cap and its use (`waiting for an agent slot: 3 of 3 in use on host
  box-b`) in the timeline and in `orca plan explain`; `hello` and `agents.list` report caps,
  sessions open and queue depth.
