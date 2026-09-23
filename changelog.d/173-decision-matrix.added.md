- **app:** Plan gains a Decisions mode: the plan's decisions as a list over the selected
  one's weighted matrix — criteria with weights and direction, options with scores, the
  weighted totals, and the recommended column outlined in accent, with `close` or `tie` said
  beside a recommendation that was not clear, and a preview labelled as one. A person decides
  from a column (with an optional rationale, sent exactly as `orca plan decide` sends it) or
  from the palette; a decided decision shows who, when and why, and reopening asks once,
  naming the items whose dependencies it reopens. The list and the matrix are split by a
  stacked, remembered splitter (`plan-decision`).
- **protocol:** `DecisionView.resultIsPreview`. A decision with no stored `result` now
  carries the matrix's recommendation computed on read (`core`'s `evaluateDecisionMatrix`),
  flagged `resultIsPreview: true`; nothing is written.
- **design:** `DecisionMatrixProps` corrected against the wire (`key`/`name`, criterion
  `direction`, `scale`, `result`, `onChoose`), and the recommended column of `.orca-matrix`
  outlined in accent.
