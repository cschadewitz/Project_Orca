- **app:** the Electron smoke test now *measures* scrolling rather than taking the
  stylesheet's word for it. With the window shrunk too short for any surface, each surface and
  the docked panel have to overflow the box they say they scroll, take a scroll to its end,
  and have their last content on screen when they get there. The renderer's sweep runs under
  happy-dom, which has no layout engine and so can only check the declaration.
