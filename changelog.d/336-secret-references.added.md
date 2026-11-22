- **engine:** secret references for agent and MCP server environments. Declare where each
  credential lives in a `secrets` section of `orca.config.yaml` (an environment variable or
  an absolute file path, bound to one host), then write `{ secret: <id> }` in `env` instead
  of the value. The value is read on that host each time a session opens, so rotation and
  revocation take effect at the next session. Over SSH the value is read by the same remote
  shell that starts the agent. It is never stored in config, launch records, events,
  artifacts or logs, never appears on a command line, and a variable a secret is read from
  is never inherited by an agent that does not reference it. A reference to a
  secret bound to another host than the agent's is refused when the config loads, with no
  fallback to a value found elsewhere. A missing value refuses the step before the agent
  starts. Values ORCA read are redacted from the run's events and logs.
