- **engine:** scoped MCP servers and skills for agent steps. Define them once in a
  `capabilities` catalog in `orca.config.yaml`, then enable, disable or replace them at the
  workspace, agent, workflow and node scopes. A workflow or node can only turn on what the
  config permits for that agent (`available`). Unknown, duplicate, conflicting and
  ambiguous references, and attempts to widen access, fail before the run starts and name
  the field. The launch preview and the run's launch record list each step's servers and
  skills with the scope that chose them, without commands or secrets. Legacy
  `agents[].mcpServers` keep working unchanged. Skills resolve with a content digest but
  cannot be delivered to agents yet, so a step that selects one is refused.
