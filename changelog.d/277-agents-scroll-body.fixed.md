- **app:** the Agents surface scrolls its cards again in a short window. It is a split
  layout — cards beside the policy inspector — but it scrolled at its root, and the split
  under that root shrank to the window while the host sections and the claims inside it
  spilled out below its bottom edge: the scrollbar moved a box the content had already left,
  so the claims were unreachable. The cards column is the scroll region now, the summary
  above it stays put, and the inspector beside it still scrolls on its own. Found by the
  measuring smoke test in the same release (#277).
