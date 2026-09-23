- **app:** Plan gains a Risks mode: the plan's likelihood × impact matrix, sized by its own
  `riskMatrix.scale` and banded by its own thresholds, with every risk labelled in place (key
  in mono, title in sans), cells above the plan's risk appetite outlined, and the critical band
  hatched so it separates in greyscale. The risk register sits under it behind a stacked,
  remembered splitter (`plan-risk`), the filter rail is the schedule's, and selecting a risk
  opens its status, the work items it holds and the journal entries that name it in the docked
  panel, whose head now names what it is showing.
- **design:** `RiskMatrixProps` in `component-api.d.ts` corrected against the wire — a variable
  `scale`, `thresholds`, an `appetite` level word, and risks by `key` and `title` — and the four
  `risk-*` grounds documented as the four core levels rather than fixed 5×5 score bands.
