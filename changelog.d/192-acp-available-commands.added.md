- **integrations:** the ACP facade advertises `/run <workflowId> [key=value ...]` and `/status`
  as ACP `available_commands_update` after `session/new`, so clients render them as real slash
  commands. An unknown `/word …` prompt (or a bare `/run`) now answers with the command list
  instead of being submitted as a Request titled `/word …`.
