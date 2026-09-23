- **integrations:** `custom:jev-eval`, a proof-of-concept node that judges explicitly selected
  artifacts with TypeSafe's JEV primitives (Choice, Score, Noul) and records an `evaluation`
  artifact carrying the rubric version, input provenance, resolved model, answers,
  distributions, confidence and token usage — never a credential. Opt-in through
  `plugins: ["@orca/integrations/jev-eval"]` with `TYPESAFE_API_KEY`; thresholds and routing
  stay in `decision` nodes reading `steps.<node>.result.data.answers`. An example shadow
  workflow lives in `examples/jev/`; `docs/INTEGRATIONS.md` has the setup, the bounded-input
  rule and the live smoke procedure.
