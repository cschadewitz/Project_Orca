- **release:** From the 0.9 line, Release (Windows server bundle) builds the Windows x64 server
  bundle for every release, signs it keylessly with its own identity, verifies and runs it on a
  clean Windows machine with a pinned cosign, and attaches it with its own record and receipt.
  It is optional on a release while Windows hosts incubate: a final publishes without it, or
  with all of it and its receipt, never with part of it (#1238).
