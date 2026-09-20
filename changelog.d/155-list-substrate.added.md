- **app:** `VirtualList`, the list substrate every list surface is built on: a window over
  fixed-height rows read from `--row-h`, a clickable status minimap over the whole list, a
  sticky context header that lifts only once content is beneath it, and `J`/`K`, the arrows,
  `Home`/`End` and the page keys registered in the keyboard map's `list` scope. The Runs
  surface is the first to adopt it, so a store of fifty thousand runs is a few dozen rows in
  the document.
