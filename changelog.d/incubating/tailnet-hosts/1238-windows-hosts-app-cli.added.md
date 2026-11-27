- **app, cli:** Add a machine and `orca remote add` set up a Windows machine as a managed ORCA
  server over its OpenSSH Server. They ask the machine which system it runs, inspect it read
  only, and after you confirm run the Windows setup in its own Windows PowerShell. That setup
  downloads and verifies the signed Windows bundle and runs the daemon as a scheduled task that
  starts at boot. Where the account may not register that, the task starts at the account's
  logon instead, both say so, and a later setup as an administrator moves it to boot. Windows
  machines on your tailnet can now be picked as hosts (#1238).
