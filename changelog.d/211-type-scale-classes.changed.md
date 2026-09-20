- **design:** `components.css` no longer sets a type size anywhere (#211). The scale in
  `tokens.json` reaches CSS only as the `.orca-text-*` classes, so a style has one definition
  rather than two: a component class carries the ground, the box, the weight and the track,
  and the element it sits on carries its type class, named by a `type:` note on the rule. The
  two rules that need a size without the rest of a style — the shell root and the empty-state
  glyph — reference the new `--text-<style>-size` and `--text-<style>-line-height` custom
  properties, which the token build now emits beside the classes. 117 literal `font-size` and
  `line-height` declarations and 23 literal box dimensions went; `pnpm run lint:css` checks
  `components.css` in full, colours and lengths both, rather than for colours only.
