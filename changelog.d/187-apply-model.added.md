- **engine:** a run's selected model reaches the agent. After `session/new` the model from
  `run.overrides.model` (or the agent's `defaultModel`) is set through the session's
  `category: "model"` config option; an agent that offers none runs only on a model its config
  declares in `models`. A model in neither place fails the step with `AGENT_MODEL_NOT_FOUND`,
  listing what is available, before any turn starts and without a retry. A pooled per-run
  session whose agent drifted off the run's model has it re-applied before the next step, and
  is closed and reopened if the agent refuses.
- **cli:** `orca status` names each step's agent and model, and `orca events` shows the model
  on the session line; the daemon's `runs.get` step view carries `model`.
