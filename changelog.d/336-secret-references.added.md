- **engine:** foundations for secret references in agent and MCP server environments.
  Declare where each credential lives in a `secrets` section of `orca.config.yaml` (an
  environment variable or an absolute file path, bound to one host) and write
  `{ secret: <id> }` in `env` instead of the value. The config is checked when it loads:
  unknown secrets, unconfigured hosts and references to a secret bound to another host than
  the agent's are refused, with no fallback to a value found elsewhere. An agent no longer
  inherits an environment variable that a secret on its host is read from. Delivering a
  value to a session needs a server-verified use check that arrives with the rest of #336;
  until then a launch whose steps use a reference is refused before it starts, and a ping
  does not start such an agent.
