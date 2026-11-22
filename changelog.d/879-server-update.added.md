- **app:** Update a remote server from the connection dialog. For a server reached through an SSH
  profile and installed by the managed server updater, the dialog shows its version, protocol and
  ring and whether it is older than the app, and **Update now** runs the server's own updater over
  the profile's pinned SSH connection to the app's version, showing its output. The server's rules
  apply unchanged: a server running work keeps its release and nothing is cancelled, and an update
  already holding the server's update lock (its scheduled updater or another operator) is reported
  as such. Nothing is installed through the daemon.
