- **engine:** a dry run simulates one exact workflow definition, such as a draft, with
  deterministic fixtures in place of agent turns and gate answers, and reports the choices made,
  the branches never taken and the assumptions behind them (#183). No agent session, workspace,
  secret, Request, work item or plugin effect takes part: planning, program and plugin nodes are
  blocked and named, and the simulated definition can never be selected by a live launch. Its
  runs are tagged `dryRun` in the event log, and nothing real can resume or recover them.
  Starting one from the app comes next.
