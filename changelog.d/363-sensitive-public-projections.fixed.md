- **store:** For a run with sensitive launch inputs, `agent.turn.started` publishes
  `promptPreview` as `[REDACTED]`. A rendered prompt can hold a sensitive value formatted as
  YAML, transformed by a template function or cut at the 400-character preview bound, which
  literal scrubbing cannot recognize. `promptHash` and the encrypted original are unchanged,
  and event logs written earlier are not rewritten.
- **store:** A sensitive `itemWorkflow` input is withheld from public launch provenance. Its
  source, and an explicit `itemWorkflow` override, stay visible.
- **cli:** With `humanInput: { mode: cli }`, the terminal prompt shows the published question
  and options, with sensitive values withheld as `orca status` shows them. Answers are
  unchanged.
