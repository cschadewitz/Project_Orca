- **integrations:** the ACP facade's `orca/model` lists real models. At `session/new` it offers
  each agent's declared `models` (or just "agent default"); when an agent's first downstream
  session opens, its advertised options replace the declaration and every open facade session
  receives a `config_option_update`, cached per agent for the facade's life. The select is
  grouped by agent when more than one agent offers models, and choosing one records
  `overrides.model` as `{ <agentId>: <modelId> }` for the next run. Downstream options in the
  other reserved categories (`mode`, `model_config`, `thought_level`) are proxied as
  `orca/<agentId>/<configId>`.
- **engine:** `Orchestrator.onAgentSessionOpened(listener)` hands each downstream
  `AgentSession` to in-process listeners as it opens.
