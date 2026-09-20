- **release:** desktop and daemon artifacts, built from the tagged commit and attached to
  the release. The desktop app is packaged per platform by electron-builder — AppImage and
  archive on Linux, dmg and zip on macOS, NSIS installer and zip on Windows — and the
  daemon is the CLI bundled to one ESM file, shipped both inside the app and beside it.
  **Both are unsigned**: macOS quarantines them and Windows SmartScreen warns about them,
  and `docs/RELEASING.md` names the secrets that fixing it needs.
- **app:** a packaged desktop app starts its own daemon. It picks `ORCA_DAEMON_URL` if set,
  then the bundled daemon on a free loopback port, then the default local `orca serve`, and
  stops what it started when it quits. The workspace it serves is `ORCA_WORKSPACE` or the
  user's home directory until the app can choose one.
