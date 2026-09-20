- **design:** `prefers-contrast: more` is honoured. `docs/design/50-accessibility-and-keyboard.md`
  has asked for it since the design system was written — swap `border-hairline` for
  `border-control`, fold `ink-tertiary` into `ink-secondary`, introduce no new palette — and
  nothing in the tree did it; only the `prefers-reduced-motion` half of that paragraph was
  ever implemented. It is two custom properties rebound on the shell root under the media
  query, so both themes keep their own values and no rule has to know the preference exists.
