`agent.session.opened` gains an optional `model`: the model the session was opened on — the
run's selection as applied, or the agent's own current model when the run selected none. Logs
written before v0.6.0 have no `model` and read as before; nothing needs migrating.
