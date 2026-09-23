- **integrations:** the ACP facade advertises session config options in `session/new` and
  handles `session/set_config_option`: `orca/workflow` (category `mode`: submit a Request
  through the program workflow, or run one workflow directly with the prompt as `vars.prompt`),
  `orca/item-workflow`, one `orca/agent.<role>` per role the configured agents fill (grouped
  by host when the candidates span hosts), `orca/model` (category `model`, "agent default"
  for now) and `orca/template-pack` (the default only, until template packs land). A client
  that advertises boolean config options also gets `orca/use-client-cwd`. The choices become
  the next run's `overrides`; a client that sets nothing gets exactly the previous behaviour.
