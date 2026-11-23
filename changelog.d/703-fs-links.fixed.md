- **agents:** When an agent asks ORCA to read or write a file on the local machine, ORCA now
  follows links in the path first. A link inside the workspace that leads outside it is
  refused, even when its target does not exist yet. A link to another file in the workspace
  is held to the rules for that file as well as the rules for the link (the stricter answer
  wins), and the read or write goes to the file the link reaches. A workspace opened through
  a linked directory still matches its own rules. Remote hosts are unchanged.
  On the local machine the read or write is also tied to the file ORCA checked: if it is
  replaced, turned into a link, or is not an ordinary file (a folder, a pipe, a device), the
  operation is refused. On Linux a new file whose folder already exists is created only inside
  the folder ORCA checked. Other new files (ones that need new folders, and any new file on
  macOS and Windows) are created on a best-effort basis: each folder is checked just before ORCA
  creates anything in it, but a change in that instant may go unnoticed, and if one is noticed
  afterwards the outcome is recorded as unknown. Remote (SSH) hosts keep their earlier behavior.
