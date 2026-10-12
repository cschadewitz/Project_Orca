- **app:** Counts agree with their nouns and stay on one line with them. The workflow editor's
  inspector said "1 edges" and "1 nodes", the Plan's decision list "0 of 1 decisions", the
  template editor "1 changed sources", and the workflow inspector "up to 1 attempts"; a count
  such as "4 changes" or "16 nodes" could also break between the number and its word. Every
  count is now written through one helper that picks the noun and joins the two with a no-break
  space, so a line can wrap between counts but never inside one.
