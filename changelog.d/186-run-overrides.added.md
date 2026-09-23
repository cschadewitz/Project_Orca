- **core:** `RunOverrides`, a per-run selection record — `roles` (role → agent id), `model`
  (one model id, or agent id → model id), `itemWorkflow` and `templatePack` — recorded in
  `run.created` and projected onto `Run.overrides` and `RunSummary.overrides`. `AgentSpec`
  gains optional `models` and `defaultModel` declarations.
- **engine:** `startRun` takes `overrides`, refuses an unknown agent or an unfilled role with
  `AGENT_NOT_FOUND` before the run is created, and hands every step a run-scoped view of the
  agent registry (`AgentRegistry.withOverrides`) instead of changing the shared one. Child
  runs inherit their parent's overrides. `plan-dispatch` picks its item workflow from the
  node's pin, then `overrides.itemWorkflow`, then `vars.itemWorkflow`; `ProgramService.submit`
  accepts `overrides`.
