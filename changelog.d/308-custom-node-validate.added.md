- **engine:** a `NodeExecutor` may declare `validate(node) => { errors?, warnings? }`, and
  `NodeExecutorRegistry.validateNode` hands it to `validateWorkflow` through the new
  `ValidationContext.validateCustomNode` hook, so a plugin's custom node is checked when the
  workflows are loaded rather than when a run reaches it. A `custom:*` type no executor
  registers is a warning saying its fields were not checked.
- **cli:** `orca validate` loads the configured plugins first, so it reports what an
  executor says about its node under the node's path (`nodes.jevShadow.rubric`), and
  bootstrap refuses to start on the same errors, the way it does for a missing template.
- **integrations:** `custom:jev-eval` validates its node at load time with the schema it
  already parses at run time; a missing `rubric:` or a `model: jev-latest` now fails
  `orca validate` instead of the run.
