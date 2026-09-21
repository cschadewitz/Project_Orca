- **app:** a chosen store whose daemon will not start is a failed open rather than a silent
  attachment to whatever else is listening. **File ▸ Open a store…** used to report the
  failure and then carry on to `ORCA_DAEMON_URL` or `127.0.0.1:6722`, so a store on a USB
  drive that could not be served showed some other store's runs under a banner naming the USB
  path as read-only. It now builds no client and opens no stream: the daemon it stopped on the
  way in stays stopped, the status bar reads `disconnected`, and the reason names the path on
  the console. The fallback is unchanged for the launch case, where the daemon that would not
  start was the placeholder over the home directory and the one on the default port is the
  daemon the app expected anyway.
