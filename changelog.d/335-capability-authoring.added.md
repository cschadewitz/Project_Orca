- **app:** the configuration form can now create, edit and remove catalog skills, catalog
  MCP servers (id and command; arguments and environment stay in raw editing) and secret
  references, whose ids it checks against the pattern the daemon describes. Capability
  selections at the workspace and agent scopes offer the catalog's ids (and, for an agent's
  MCP servers, its own inline servers) instead of free text.
