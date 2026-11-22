- **app:** Update a remote server from the connection dialog. For a server reached through an SSH
  profile and installed by the managed server updater, the dialog shows its version, protocol, ring
  and host key and whether it is older than the app. After you approve that server's updater for
  the profile (the dialog shows the exact command), **Update now** runs it over the profile's
  pinned SSH connection to the app's version, showing its output. The app runs only the approved
  updater, refuses when the server reports another one, and reports "updated" only once the server
  itself confirms the new version; a connection lost mid-update is reported as unknown. The
  server's rules apply unchanged: a server running work keeps its release and nothing is
  cancelled, and an update already holding the server's update lock is reported as such.
