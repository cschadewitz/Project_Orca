- **deploy:** `tools/deploy/orca-server-setup.ps1` sets up a Windows x64 machine as a managed ORCA
  server in one step, as the Linux setup does: as the signed-in account, under
  `%LOCALAPPDATA%\orca-server`, it verifies the signed Windows server bundle with the pinned
  cosign before unpacking it, runs it, receipts it, and runs the daemon from a per-user
  scheduled task that starts at boot with no stored password. Every step is idempotent, an
  installation it did not make is refused, and a failed or interrupted run is put back (#1238).
