`run.created` gains an optional `overrides` field carrying the run's selection record (role
→ agent, model, item workflow, template pack), so a replay resolves the same agents the live
run did even after the config's role mapping changes. It is additive: run logs written before
v0.6.0 have no such field and read as a run with no overrides, and nothing needs migrating.
An older ORCA reading a v0.6.0 store drops the unknown key rather than failing, so such a
run replays there with the config's role mapping instead of its recorded selection.
