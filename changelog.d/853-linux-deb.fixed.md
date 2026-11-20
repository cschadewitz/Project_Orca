- **app:** Ship a `.deb` for Linux x64 and arm64 and make it the supported Linux install.
  On stock Ubuntu 24.04 the `tar.gz` aborted before its first window because Chromium's
  sandbox could not start; the package's install script loads an AppArmor profile for
  `/opt/ORCA/orca` alone, so the app starts with its sandbox on and nothing else on the
  system changes. See `docs/INSTALL-LINUX.md`. (#853)
