- **engine:** catalog skills now reach agent sessions. A step's selected skills travel in
  its prompts as ACP `resource` blocks with their text inline, read on the daemon's machine
  and hashed over exactly what is sent. They need the run owner's `capabilities` grant
  (`orca auth issue <principal> --skill <id>` pins the content digest; `--skill '*'` and the owner
  preset cover every skill, while `--mcp-server '*'` grants servers only) and an agent that accepts embedded context. Otherwise the step
  is refused, never run without the skill.
