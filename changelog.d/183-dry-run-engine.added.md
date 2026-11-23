- **engine:** a dry run simulates one exact workflow definition, such as a draft, with
  deterministic fixtures in place of agent turns and gate answers, and reports the choices made,
  the branches never taken and the assumptions behind them (#183). No agent session, workspace,
  secret, Request, work item or plugin effect takes part: a custom node runs only an explicit
  `simulate`, and is otherwise blocked and named. Its runs are tagged `dryRun` in the event log,
  and nothing real can resume or recover them. Starting one from the app comes next.
