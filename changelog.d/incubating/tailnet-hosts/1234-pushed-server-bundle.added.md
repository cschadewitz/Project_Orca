- **deploy/app:** A machine with no internet access can be set up as a managed server (#1234).
  Your computer fetches the signed server bundle, the pinned cosign and Sigstore's trusted root,
  checks their digests, and copies them over the profile's pinned SSH connection; the server
  still checks the bundle's signature itself before installing it. `orca-release.py stage
  --bundle <dir>` uses a pushed cosign (only if it matches the pinned digest) and a pushed
  `trusted_root.json` found beside the bundle.
