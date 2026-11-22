- **app:** Update a remote server from the connection dialog. For a server reached through an SSH
  profile and installed by the managed server updater, the dialog shows its version, protocol,
  ring, host key and workspace and whether it is older than the app. You enter the server's
  updater and manifest paths once (the server's own report is shown as a hint and must match),
  and the approval holds for that server's host key and workspace only. **Update now** then runs
  that updater over the profile's pinned SSH connection to the app's version, showing its
  output. The app only updates a server that is older than it, and the server's updater refuses
  (new `update --expect-current`) if another update moved it after you checked; reports "updated" only once the
  server itself confirms the new version, and reports a connection lost mid-update as unknown.
  The server's rules apply unchanged: a server running work keeps its release and nothing is
  cancelled, and an update already holding the server's update lock is reported as such.
