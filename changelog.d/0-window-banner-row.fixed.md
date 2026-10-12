- **app:** The connection bars and a link's landing notice sit in the primary pane under the
  object header, as `docs/design/40-connection-states.md` places them, instead of stretching
  across the window above the sidebar and squeezing the app into the status bar's row. The
  landing notice appears only when a link could not be honoured (an unknown URL, no daemon
  answering, a work item the plan does not hold, a counterpart the app cannot follow yet);
  a link that worked no longer says "Opened …". Dismissing the notice no longer closes the
  workflow it was about. The Runs left column also no longer spills under the step detail
  when the detail is dragged wide.
