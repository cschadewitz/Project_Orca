- **app:** SSH profiles sign in on their own. The first connect has ORCA's command line on the
  server issue this computer a credential over the profile's pinned SSH connection and keeps it
  in the system keychain, with no token to copy. The app checks it with the daemon, renews it
  before it expires, replaces a revoked or expired one once, and revokes it on the server when
  the profile is removed. Profiles gain a server command (for a managed install's wrapper), a
  workspace config path and a read-only option, and each setup failure says what to do.
