- **deploy:** a server set up with "Set up as ORCA server" now starts. Its new config lists
  no workflows until you declare agents for them: the release's own workflows need agents
  for their roles, and the daemon refused to start without them.
- **app:** setting up or checking a server over SSH from Windows no longer times out. The
  setup program is now sent to the server; before, ssh was given no input at all.
- **app:** the SSH profile editor in the connection dialog lays out at normal window sizes,
  and the dialog scrolls instead of hiding Save.
