- **app, cli, deploy:** A Windows machine on your tailnet can now have its OpenSSH Server turned
  on for ORCA. Add a machine shows a line for an administrator PowerShell there, and so does
  `orca remote windows-ssh`. The line downloads `orca-windows-ssh.ps1` for your version and runs
  it only if it matches the copy your ORCA install ships. When the OpenSSH Server is already on,
  it changes nothing. Otherwise it lists each change and asks before making any:
  - install the Windows feature;
  - allow SSH over the Tailscale adapter, and block it on every other network adapter and from
    every address outside Tailscale's, with a scheduled task that keeps the adapter block up to
    date and stops `sshd` when it cannot;
  - start `sshd`, only once that block is in place.

  It refuses when the block would not hold, such as a firewall profile that is off or a policy
  that turns local firewall rules off. Windows Update keeps the
  OpenSSH Server updated; ORCA does not bundle it (#1238).
