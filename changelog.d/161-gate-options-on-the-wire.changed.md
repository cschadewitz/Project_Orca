- **protocol:** `OpenInputView.options` and `input.opened`'s `options` carry the whole
  `GateOption` — `{ id, label, consequence?, destructive? }` — instead of an array of ids.
  A client could answer a gate it had no way to render; it can now show the label, the
  consequence clause and the destructive flag the design requires before offering a choice.
  `id` is still the whole of the answer, and a log written before the model changed still
  reads as options that are their own ids and labels.
