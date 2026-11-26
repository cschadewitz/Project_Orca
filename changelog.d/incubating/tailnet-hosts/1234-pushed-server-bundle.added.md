- **deploy/app:** A machine with no internet access can be set up as a managed server (#1234).
  Your computer fetches the signed server bundle, the pinned cosign and Sigstore's trusted root,
  checks their digests, and copies them over the profile's pinned SSH connection; the server
  still checks the bundle's signature itself before installing it. Only with the explicit
  `orca-release.py stage --bundle --offline <dir>` does it use the carried cosign (only if it
  matches the pinned digest) and `trusted_root.json` (only if this release pins its digest).
