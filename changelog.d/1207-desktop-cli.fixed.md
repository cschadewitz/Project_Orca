- **app:** desktop installs ship ORCA's command line as `orca-cli` (#1207). The Windows
  installer puts it on the user `PATH` (open a new terminal after installing) and the
  uninstaller takes it off; the Ubuntu `.deb` installs `/usr/bin/orca-cli`. It is never plain
  `orca`, which on Ubuntu Desktop is the GNOME screen reader. The docs now write commands as
  `orca-cli …`.
