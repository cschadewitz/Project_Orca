- **app:** the Linux `.deb` says when a newer release is out. About 15 seconds after start
  and every six hours it reads the public release list and, when a newer stable release has
  a `.deb` for the machine, shows a notice in the title bar with the release page and the
  `apt` command. It never downloads or installs anything, an offline or failed check is
  silent, prereleases are offered only with `ORCA_UPDATE_PRERELEASE=1` as on Windows, and
  `ORCA_UPDATE_CHECK=0` turns the check off.
