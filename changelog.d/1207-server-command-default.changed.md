- **remote:** a remote's or app profile's `serverCommand` now defaults to `orca-cli` instead
  of `orca` (#1207), so it never reaches the screen reader on an Ubuntu Desktop server.
  Profiles made by the app's server setup already name their launcher's full path and are
  unchanged. A server running ORCA from a source checkout gets `orca-cli` beside `orca` once
  the CLI package is linked again; or set `serverCommand: orca` to keep the old name.
