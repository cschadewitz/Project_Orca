- **deploy:** `orca-windows-ssh.ps1` turns on the OpenSSH Server that Windows ships, so a Windows
  machine on your tailnet can be set up as an ORCA server. It changes nothing when the server is
  already on. Otherwise it lists each change and asks before making any: it installs the Windows
  feature, starts `sshd` automatically and allows SSH only over the Tailscale adapter. Windows
  Update keeps it updated; ORCA does not bundle it (#1238).
