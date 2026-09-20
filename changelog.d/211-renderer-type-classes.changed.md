- **app:** every element in the renderer that takes a component class now also takes the
  `.orca-text-*` class that class expects (#211). `components.css` stopped setting a type size
  in wave zero, so until now the chrome, the command palette, the Runs surface and the `ui/`
  primitives were all inheriting the shell's 14px instead of the chip's, the crumb's or the
  row's intended size — visible, but not obviously wrong, and nothing failed. 46 elements
  across 16 files change class names only; no markup, behaviour, prop or accessible name
  moved. `#preview` now renders each primitive at the size the design system intends.
- **app:** a test sweeps the `type:` notes out of `components.css` and asserts, over the
  rendered chrome, palette, Runs surface and every `ui/` primitive, that nothing carrying a
  noted class is missing its type class, carrying the wrong one, or carrying two (#211). The
  expected side is read from the stylesheet with `querySelectorAll`, so adding a `type:` note
  to a new component class is enough to put every element that takes it under the test — this
  is the guard the later v0.4.0 surfaces inherit rather than re-deriving.
