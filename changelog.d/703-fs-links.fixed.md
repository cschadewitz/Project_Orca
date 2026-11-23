- **agents:** When an agent asks ORCA to read or write a file on the local machine, ORCA now
  follows links in the path first. A link inside the workspace that leads outside it is
  refused, even when its target does not exist yet. A link to another file in the workspace
  is held to the rules for that file as well as the rules for the link (the stricter answer
  wins), and the read or write goes to the file the link reaches. A workspace opened through
  a linked directory still matches its own rules. Remote hosts are unchanged.
  On the local machine the read or write is also tied to the file ORCA checked: if it is
  replaced or turned into a link before the I/O starts, the operation is refused. For a new
  file, each folder it is created in is checked again just before ORCA creates anything there.
  Remote (SSH) hosts keep their earlier behavior.
