- **app:** an artifact diff against an empty version no longer counts a removed line that
  does not exist. `"".split("\n")` is one empty string, so v1 of an artifact — or a body a
  tool recorded as the empty string — diffed as a file of one blank line and the panel said
  "1 added, 1 removed" for what is a pure creation. An empty *body* now contributes no
  lines, in either direction: a creation reads "1 added", an emptied artifact reads "1
  removed", and two empty versions are no change at all. The gutters and the line bodies
  were always right; only the sentence above them lied. Splitting is unchanged, so a file
  whose one line is blank is still a file with a line in it.
