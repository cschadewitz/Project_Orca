- **app:** `VirtualList` takes a `scope` — `list`, `run-tree` or `stream` — so one screen can
  hold three lists and `J` still means "next" in whichever one the focus is in. One list per
  *scope* rather than one per screen; two in one scope still throws, which remains how a
  collision is found. It also takes `follow` with an `onHold` that fires once when a scroll
  leaves the end, and exposes `reveal(index)` and `shiftBy(rows)` on a ref — `shiftBy` being
  what a list that pages *backwards* needs, since without it "load earlier" throws a person
  back by exactly the page they asked for.
