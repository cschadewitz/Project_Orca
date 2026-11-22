- **app:** Windows arm64 installs get updates. Finals now attach the signed arm64 installer
  beside x64, accept it automatically on a native Windows arm64 machine (signature, install
  over the previous arm64 release, ARM64 binary, app reaches its bundled daemon), and the
  desktop feed serves arm64 for any release whose arm64 installer passed that acceptance.
  x64 feeding is unchanged.
