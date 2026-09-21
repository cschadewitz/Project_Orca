- **design:** the five surfaces have designed glyphs — ◆ Attention, ☰ Runs, ⬡ Plan,
  ◉ Agents, ❋ Config — declared in `semantics.json` and bundled in the symbol face, so the
  rail the sidebar collapses to below 960px draws the same five shapes on every platform.
  They replace the placeholders the app had picked for itself, among them a ⚙ that no
  bundled face carried and so came from whatever the operating system had, and a filled and
  an outlined diamond that differed by a hairline on the two surfaces a person moves between
  most. The five are now told apart in greyscale at icon size: a solid diamond, three bars,
  a hollow hexagon, a ring round a dot, a radial burst. Attention keeps the waiting status's
  ◆ on purpose.
- **app:** the sidebar reads its order, words and glyphs from `@orca/design` instead of
  declaring them. Every item keeps its label as its accessible name and its `⌘1`–`⌘5`
  address at every width; the expanded sidebar is unchanged.
