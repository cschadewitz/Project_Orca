- **app, cli, deploy:** A Windows machine on your tailnet can now have its OpenSSH Server turned
  on for ORCA. Add a machine shows a line for an administrator PowerShell there, and so does
  `orca remote windows-ssh`. The line downloads `orca-windows-ssh.ps1` for your version and runs
  it only if it matches the copy your ORCA install ships. When the OpenSSH Server is already on,
  it changes nothing. Otherwise it lists each change and asks before making any:
  - install the Windows feature;
  - allow SSH only over the Tailscale adapter;
  - start `sshd`, only once SSH is allowed nowhere else.

  It refuses when another firewall rule or profile would leave SSH open. Windows Update keeps the
  OpenSSH Server updated; ORCA does not bundle it (#1238).
