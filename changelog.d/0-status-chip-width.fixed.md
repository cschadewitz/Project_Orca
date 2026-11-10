- **app:** Status chips no longer clip their word, on any surface. The run tree and the Agents
  claims list each held the chip to a 12ch column, narrower than "✓ succeeded"; the run tree
  was fixed on its own and the claims list kept the bug. The chip now sizes itself and is never
  narrower than its glyph and word, and a list whose statuses form one column asks the chip for
  it (`StatusChip`'s `aligned`) rather than setting a width.
