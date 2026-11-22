- **engine:** catalog MCP servers now reach agent sessions. A step that selects a server
  from `capabilities.mcpServers` gets it only when the run's owner holds a current
  credential with `capabilities.use` whose grant names that server, as defined now, on the
  agent's host (`orca auth issue <principal> --mcp-server <id>@<host>`, or `'*'`; the owner
  preset grants every server), and its command is found on that host. A grant naming a
server covers it only when its command is an absolute, canonical path to an executable that
only root or the agent's account can change; anything else needs `'*'`. The decision is
asked again after a slot wait, right before the agent is given its servers, and before
every prompt, so a revoked grant stops a waiting step and retires a pooled session. Otherwise the step is
  refused before anything starts, naming the step and the server. ORCA never installs a
  server and never tries another host. Skills are still refused until they can be delivered.
