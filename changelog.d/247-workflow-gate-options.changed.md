- **core:** a `gate` or `decision` node's `options` may now be records —
  `{ id, label, consequence?, destructive? }` — as well as bare words. A workflow can
  therefore say what choosing an option *does*, and mark the one that destroys something, so
  the attention surface's two safety properties (show the consequence, never bind the
  destructive option to a number key) are properties of real gates rather than of fixtures.
  A bare word still reads as an option that is its own id and its own label: every workflow
  on disk keeps working and there is no migration.
- **core/engine:** everything mechanical about an option is its **id**, and always was —
  `defaultOption`, `autoOption`, the `when: "choice == '<option>'"` on an outgoing edge, the
  value a decision source has to produce, and the answer recorded on `human.answered`. A
  label is for a person and may be reworded without touching the graph or invalidating an
  answer already in a log. `vars.options` and the `fieldValues` an agent-sourced decision is
  validated against carry the ids, so a consequence clause never reaches a prompt as though
  it were a choice.
