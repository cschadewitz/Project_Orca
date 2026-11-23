- **agents:** When an agent asks ORCA to read or write a file on the local machine, ORCA now
  follows links in the path first. A link inside the workspace that leads outside it is
  refused, even when its target does not exist yet. A link to another file in the workspace
  is held to the rules for that file as well as the rules for the link (the stricter answer
  wins), and the read or write goes to the file the link reaches. A workspace opened through
  a linked directory still matches its own rules. Remote hosts are unchanged.
  On the local machine the read or write is also bound to the file ORCA checked: if it is
  replaced, turned into a link, or a new file appears in its place before the I/O starts, the
  operation is refused.
