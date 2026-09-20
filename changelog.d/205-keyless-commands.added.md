- **app:** a shortcut may have no key. `Shortcut.key` is optional, a keyless command takes a
  slot of its own in the registry (so the duplicate-key throw that finds real collisions is
  untouched), `handle()` cannot dispatch to one, and the palette renders its row with no chip
  beside it. **Cancel the run this is waiting on** and **Resume the run this is waiting on**
  are the first two: real write actions, reachable from the palette and nowhere else.
