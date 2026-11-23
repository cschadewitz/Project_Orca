- **app:** the configuration form can now create, edit and remove catalog skills, catalog
  MCP servers (id and command; arguments stay in raw editing) and secret references, whose
  ids it checks against the pattern the daemon describes. A catalog MCP server's environment
  is edited with a secret picker: each variable references one of the configuration's
  secrets, and an existing literal value is never shown, only replaced or removed. Capability
  selections at the workspace and agent scopes offer the catalog's ids (and, for an agent's
  MCP servers, its own inline servers) instead of free text.
- **app:** reviewing a configuration change now previews, for each affected agent, which MCP
  servers and skills it gets once applied, against the running configuration, and which
  scope decides each one. `config.get` and `config.set` (under `validateOnly`) report these
  sets as `capabilities`: ids and sources only, never definitions.
