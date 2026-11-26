- **app:** a remote daemon profile created with the server command left empty now saves
  `orca-cli` (#1207), the command desktop installs provide. Profiles saved before 0.8.1 that
  left it empty keep using `orca`, and each issued credential records the command it was
  issued through, so it is revoked through the same one. A workspace config's
  `remotes[].serverCommand` still means `orca` when omitted; write `orca-cli` for a server
  with a desktop install, where on Ubuntu Desktop `orca` is the screen reader.
