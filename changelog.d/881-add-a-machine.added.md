- **app, cli:** Make a reachable Linux machine a managed ORCA server in one step: **Add a
  machine** in the connection dialog, or `orca remote add user@host` from a source checkout.
  Over the profile's pinned SSH connection it checks the platform, installs this version's
  signed server bundle, the wrappers and the systemd user unit, starts the daemon and checks it,
  and in the app then signs in automatically. A re-run verifies and repairs instead of
  reinstalling; a machine with an unmanaged ORCA installation is refused with the inventory
  guidance; a failed run leaves no `current` link and no enabled unit behind.
