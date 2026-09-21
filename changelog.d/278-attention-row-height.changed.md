- **design:** `.orca-attn__row` is bound to `--row-h` like every other row class, rather than
  being padded to a height of its own. The Attention surface's failed-runs and running-runs
  lists are virtualised, and the virtualiser reads a row's height back off that token, so a
  padded row was a row the window arithmetic was wrong about. The app's own correcting
  modifier is gone with it.
- **design:** `.orca-agent__health` — the glyph-and-word an agent card leads with — is in the
  component layer next to `.orca-agent__name`, where the rest of the card already was. It was
  written in the Agents surface's own stylesheet because nothing named it here.
