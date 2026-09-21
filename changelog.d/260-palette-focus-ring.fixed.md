- **design:** the command palette's field draws a focus ring again. It carried the system's
  one `outline: none`, deferring to a ring on the palette that was never written — so ⌘K put
  focus into the only focusable thing on screen and nothing indicated it. The suppression is
  gone rather than the compensating ring being invented: the field takes the same
  `:focus-visible` ring as everything else, from `--border-focus`, because one ring keyed the
  way the spec keys it is better than a second one on the overlay that would also draw itself
  after a mouse click. Its offset is inset by the ring's own width, since the overlay clips
  its content and a full-width field would otherwise lose three sides of an outward ring.
  Nothing in the component layer or the app's stylesheets suppresses focus now (RULES.md
  rule 10), and the test that allowlists suppressions is down to an empty list.
