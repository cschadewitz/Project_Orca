- **agents:** an agent session keeps the config options its agent advertises in `session/new`
  (a model list, a mode, a reasoning level) as `AgentSession.configOptions`, normalised into
  ORCA's own `SessionConfigOption`; legacy `modes` become one select with `category: "mode"`,
  and `configOptions` wins when an agent sends both. `setConfigOption(configId, value)` sends
  `session/set_config_option`, an unsolicited `config_option_update` refreshes the cache and
  is logged as an agent update, and ORCA now tells agents it can set boolean options. The
  scripted agent advertises a configurable option set (`configOptions` on the playbook and on
  `scriptedAgentSpec`).
