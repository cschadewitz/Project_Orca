- **deploy:** `tools/deploy/server-bundle.py --platform win-x64` assembles the headless server
  bundle for Windows x64 hosts as a deterministic zip with its own `node.exe`, and a Windows
  check runs the unpacked bundle's version, demo, `validate` and daemon hello on every change to
  how it is built (#1238).
