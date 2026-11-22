- **app:** SSH profiles sign in on their own. The first connect has ORCA's command line on the
  server issue this computer a credential over the profile's pinned SSH connection and keeps it
  in the system keychain, with no token to copy. A new credential is used only once the daemon
  has accepted it. It is renewed before it expires, a revoked or expired one is replaced once,
  and every replaced credential is revoked on the server and workspace it came from, including
  when the profile is removed. Imported credentials are never replaced. Profiles gain a server
  command (for a managed install's wrapper), a workspace config path and a read-only option, and
  each setup failure says what to do.
