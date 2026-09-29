- **cli:** `orca run` takes `--agent <role>=<agentId>` and `--model <agentId>=<modelId>`, both
  repeatable, plus `--model <modelId>` alone when the run uses exactly one agent and
  `--template-pack <name>`; `orca submit` and `orca plan dispatch` take the same flags and
  `--item-workflow <id>`. They become the run's selection record, so an unknown role, agent,
  model or workflow is refused with the known set before the run starts.
- **cli:** `orca plan dispatch --workflow` is documented as choosing the *program* workflow,
  and one without a `custom:plan-dispatch` node is refused with `CONFIG_INVALID`.
- **cli:** `orca agents` lists each agent's declared models with the default marked, and the
  models a running daemon has discovered, or "not probed".
