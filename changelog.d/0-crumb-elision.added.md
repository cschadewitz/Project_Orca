- **app:** The object header shortens a trail that does not fit. Its middle folds into a
  `…` control, nearest the root first, down to `request ▸ … ▸ run ▸ step`; then the run
  folds too, `request ▸ … ▸ step`; only then is the current crumb's name cut at its end. The
  first crumb and the current one never fold, and type labels, id tokens and versions are
  never cut. Fit is measured, so a wide window still shows the whole chain, and the Plan mode
  control and the Workflows header actions keep their width. `…` opens a menu of the hidden
  crumbs, each with its type, name and token, and choosing one goes where that crumb would
  have. It is a button in the tab order, and its accessible name lists the levels it holds
  in order, so a screen reader still hears the whole chain.
