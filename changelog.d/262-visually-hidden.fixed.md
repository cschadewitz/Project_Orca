- **design:** the component layer has a `.orca-visually-hidden` utility — in the
  accessibility tree, nowhere on screen — so nothing app-side has to rewrite the clip. The
  polite announcer wears it and `app.css` is back to the window filling the window, which
  takes the app's `orca-allow-literal` count to zero. One note moved with the class and is
  now the only one in the tree: a single exemption covering the `1px` box that keeps the
  element rendered, arguing the permanent case rather than naming an issue to wait on —
  `display: none`, a zero box and `visibility: hidden` each drop the element out of the
  accessibility tree in some screen reader, which for a live region is not "hidden" but
  "off". It is a class and deliberately not a component: its callers are a `div`, an `h2`
  and a `label`, and a wrapper would have to pick one.
