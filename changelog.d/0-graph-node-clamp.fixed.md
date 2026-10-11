- **app:** Graph nodes on the workflow viewer, the workflow editor and the Plan dependency
  graph keep a fixed height, so edges meet them where the layout drew them. A long name used
  to wrap onto as many lines as it took, and a running node's meta line ("running · attempt
  2 · 3 nested graphs") onto several more, growing the box past its slot. Now a node's name
  is at most two lines and its kind and meta line one each, all cut at their end with the
  full text in a tooltip. The full name is still in the node's accessible name, after its
  status, and in the inspector. The node height token, `node-h`, goes from 64px to 112px so
  the kind, a two-line name and a meta line with a status chip fit whole; start and end
  pills stay as tall as their text and are centred in their slot.
