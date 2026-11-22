- **engine:** catalog MCP servers now reach agent sessions. A step that selects a server
  from `capabilities.mcpServers` gets it only when the run's owner holds a current
  credential with `capabilities.use` whose grant names that server, as defined now, on the
  agent's host (`orca auth issue <principal> --mcp-server <id>@<host>`, or `'*'`; the owner
  preset grants every server), and its command is found on that host. Otherwise the step is
  refused before anything starts, naming the step and the server. ORCA never installs a
  server and never tries another host. Skills are still refused until they can be delivered.
